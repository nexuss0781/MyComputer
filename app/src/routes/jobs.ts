import { dispatchSchema } from '@mycomputer/shared';
import type { Hono } from 'hono';
import type { Executor } from '../../core/executor.js';
import type { JobStore } from '../../core/job-store.js';
import type { Oplog } from '../../core/oplog.js';
import { errorResponse, errorStatus } from './fs.js';

export interface JobsDeps {
  jobStore: JobStore;
  executor: () => Executor | null;
  journal: Oplog;
}

export function jobsRoutes(deps: JobsDeps, app: Hono): void {
  app.post('/api/sys/dispatch', async (c) => {
    try {
      const body: unknown = await c.req.json().catch(() => null);
      const parsed = dispatchSchema.safeParse(body);
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
      const { sessionId, kind, payload, timeoutMs } = parsed.data;

      const job = await deps.jobStore.insert(sessionId, kind, {
        ...payload,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });

      await deps.journal.record(
        'dispatch',
        sessionId,
        { jobId: job.jobId, kind, payload },
        { jobId: job.jobId, state: job.state },
        'ok',
      );

      return c.json({ ok: true, data: job });
    } catch (error) {
      return c.json(errorResponse(error), errorStatus(error));
    }
  });

  app.get('/api/sys/jobs', async (c) => {
    try {
      const sessionId = c.req.query('sessionId');
      if (!sessionId) {
        return c.json(
          { ok: false, error: { code: 'invalid_input', message: 'sessionId required' } },
          400,
        );
      }
      const offset = Number(c.req.query('offset') ?? '0');
      const limit = Number(c.req.query('limit') ?? '100');
      const jobs = await deps.jobStore.list(sessionId, offset, limit);
      return c.json({ ok: true, data: jobs });
    } catch (error) {
      return c.json(errorResponse(error), errorStatus(error));
    }
  });
}
