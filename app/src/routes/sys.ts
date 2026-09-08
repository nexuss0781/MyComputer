import { sessionCreateSchema } from '@mycomputer/shared';
import type { Hono } from 'hono';
import type { Executor } from '../../core/executor.js';
import type { FsEngine } from '../../core/fs-engine.js';
import { runPersistenceSelftest } from '../../core/persistence-selftest.js';
import { type SelftestEnvironment, runSelftest } from '../../core/selftest.js';
import type { SyncWriter } from '../../core/sync.js';
import type { PersistenceSelftestFactory } from '../runtime.js';
import type { SessionStore } from '../session.js';
import { errorResponse, errorStatus } from './fs.js';

export interface SysDeps {
  engine: () => FsEngine | null;
  sessions: SessionStore;
  executor: () => Executor | null;
  sync: SyncWriter | null;
  persistenceFactory: () => PersistenceSelftestFactory | null;
  environment: SelftestEnvironment;
}

export function sysRoutes(deps: SysDeps, app: Hono): void {
  app.post('/api/sys/session', async (c) => {
    try {
      const body: unknown = await c.req.json().catch(() => null);
      const parsed = sessionCreateSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_input',
              message: parsed.error.issues[0]?.message ?? 'invalid payload',
            },
          },
          400,
        );
      }
      const { name, meta } = parsed.data;
      const session = await deps.sessions.create({ name, meta });
      const live = deps.engine();
      if (live) await live.sessionInit(session.id);
      return c.json({ ok: true, data: session });
    } catch (error) {
      return c.json(errorResponse(error), errorStatus(error));
    }
  });

  app.get('/api/sys/session', async (c) => {
    try {
      const sessions = await deps.sessions.list();
      return c.json({ ok: true, data: sessions });
    } catch (error) {
      return c.json(errorResponse(error), errorStatus(error));
    }
  });

  app.delete('/api/sys/session/:id', async (c) => {
    try {
      const id = c.req.param('id');
      const live = deps.engine();
      const executor = deps.executor();
      if (live) {
        await live.resetSession(id);
        await live.remove(id, '/', true).catch(() => {});
      }
      await executor?.removeSessionData(id);
      if (deps.sync) {
        // Buffered deletions persist only on flush; must be durable before we
        // drop the session row (FK to inodes/meta/blocks/executions).
        await deps.sync.flush();
      }

      let journalPreserved = false;
      try {
        await deps.sessions.remove(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('operations') || message.includes('foreign key')) {
          journalPreserved = true;
        } else {
          throw error;
        }
      }

      return c.json({
        ok: true,
        data: { deleted: id, journalPreserved },
      });
    } catch (error) {
      return c.json(errorResponse(error), errorStatus(error));
    }
  });

  app.post('/api/sys/selftest', async (c) => {
    const start = Date.now();
    const live = deps.engine();
    if (!live)
      return c.json(
        {
          ok: false,
          error: { code: 'engine_not_configured', message: 'fs engine not configured' },
        },
        503,
      );
    const result = await runSelftest(live, deps.environment, deps.sessions, deps.executor());
    const payload = { ...result, endpointTookMs: Date.now() - start };
    const factory = deps.persistenceFactory();
    if (factory && result.ok) {
      const p4 = await runPersistenceSelftest(factory);
      Object.assign(payload, {
        persistence: {
          total: p4.total,
          passed: p4.passed,
          failed: p4.failed,
          flushBatchMs: p4.flushBatchMs,
        },
        total: payload.total + p4.total,
        passed: payload.passed + p4.passed,
        failed: payload.failed + p4.failed,
        failures: [...payload.failures, ...p4.failures],
        ok: payload.ok && p4.ok,
      });
    }
    return c.json({ ok: payload.ok, data: payload }, payload.ok ? 200 : 500);
  });
}
