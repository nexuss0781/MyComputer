import { execLogSchema, execRunSchema } from '@mycomputer/shared';
import type { Context } from 'hono';
import type { Hono } from 'hono';
import type { Executor } from '../../core/executor.js';
import type { FsEngine } from '../../core/fs-engine.js';
import { errorResponse, errorStatus } from './fs.js';

export interface ExecDeps {
  engine: () => FsEngine | null;
  executor: () => Executor | null;
}

const badInput = (c: Context, message: string) =>
  c.json({ ok: false, error: { code: 'invalid_input', message } }, 400);

const unconfigured = (c: Context) =>
  c.json(
    { ok: false, error: { code: 'executor_not_configured', message: 'executor not configured' } },
    503,
  );

export function execRoutes(deps: ExecDeps, app: Hono): void {
  app.post('/api/exec/run', async (c) => {
    const live = deps.executor();
    if (!live) return unconfigured(c);

    const rawBody: unknown = await c.req.json().catch(() => null);
    const parsed = execRunSchema.safeParse(rawBody);
    if (!parsed.success) {
      return badInput(c, parsed.error.issues[0]?.message ?? 'invalid payload');
    }

    const { sessionId, command, cwd, timeout } = parsed.data;
    const started = Date.now();
    try {
      const execution = await live.run(sessionId, { command, cwd, timeoutMs: timeout });
      const engine = deps.engine();
      if (engine) {
        await engine.oplog.record(
          'exec',
          sessionId,
          { command, cwd: cwd ?? null },
          { execId: execution.execId, exitCode: execution.exitCode, timedOut: execution.timedOut },
          execution.timedOut ? 'error' : 'ok',
          execution.durationMs,
        );
      }
      return c.json({ ok: true, data: execution });
    } catch (error) {
      const engine = deps.engine();
      if (engine) {
        await engine.oplog.recordError(
          'exec',
          sessionId,
          { command, cwd: cwd ?? null },
          error instanceof Error
            ? { code: 'internal', message: error.message }
            : { code: 'internal', message: 'exec failed' },
          Date.now() - started,
        );
      }
      return c.json(errorResponse(error), errorStatus(error));
    }
  });

  app.post('/api/exec/log', async (c) => {
    const live = deps.executor();
    if (!live) return unconfigured(c);

    const rawBody: unknown = await c.req.json().catch(() => null);
    const parsed = execLogSchema.safeParse(rawBody);
    if (!parsed.success) {
      return badInput(c, parsed.error.issues[0]?.message ?? 'invalid payload');
    }

    const { sessionId, execId, offset, limit } = parsed.data;
    try {
      if (execId) {
        const execution = await live.get(sessionId, execId);
        if (!execution) {
          return c.json(
            { ok: false, error: { code: 'not_found', message: `execution ${execId} not found` } },
            404,
          );
        }
        const stdoutLines = execution.stdout.split('\n');
        const startLine = offset ?? 0;
        const endLine = limit !== undefined ? startLine + limit : undefined;
        return c.json({
          ok: true,
          data: {
            ...execution,
            stdout: stdoutLines.slice(startLine, endLine).join('\n'),
            totalLines: stdoutLines.length,
          },
        });
      }
      const rows = await live.list(sessionId, offset ?? 0, limit ?? 100);
      return c.json({
        ok: true,
        data: {
          total: rows.length,
          offset: offset ?? 0,
          limit: limit ?? 100,
          executions: rows.map((r) => ({ ...r, stdout: r.stdout.slice(0, 2000) })),
        },
      });
    } catch (error) {
      return c.json(errorResponse(error), errorStatus(error));
    }
  });
}
