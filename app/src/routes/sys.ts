import { sessionCreateSchema } from '@mycomputer/shared';
import type { Hono } from 'hono';
import type { FsEngine } from '../../core/fs-engine.js';
import { type SelftestEnvironment, runSelftest } from '../../core/selftest.js';
import type { SessionStore } from '../session.js';
import { errorResponse, errorStatus } from './fs.js';

export interface SysDeps {
  engine: () => FsEngine | null;
  sessions: SessionStore;
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
      if (live) {
        await live.resetSession(id);
        await live.remove(id, '/', true).catch(() => {});
      }
      await deps.sessions.remove(id);
      return c.json({ ok: true, data: { deleted: id } });
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
    const result = await runSelftest(live, deps.environment);
    return c.json(
      { ok: result.ok, data: { ...result, endpointTookMs: Date.now() - start } },
      result.ok ? 200 : 500,
    );
  });
}
