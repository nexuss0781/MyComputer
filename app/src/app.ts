import { Hono } from 'hono';
import { execRoutes } from './routes/exec.js';
import { fsRoutes } from './routes/fs.js';
import { sysRoutes } from './routes/sys.js';
import { toolRoutes } from './routes/tools.js';
import {
  coldSelftestFactory,
  getRuntime,
  persistenceSelftestFactory,
  reconcileAllPending,
} from './runtime.js';

export function createApp(): Hono {
  const app = new Hono();

  const runtime = getRuntime();

  app.get('/api/sys/ping', (c) =>
    c.json({
      ok: true,
      service: 'my-computer',
      route: '/api/sys/ping',
    }),
  );

  app.post('/api/sys/fsync', async (c) => {
    let body: { sessionId?: string } = {};
    try {
      const parsed = await c.req.json().catch(() => ({}));
      body = parsed ?? {};
    } catch {
      body = {};
    }

    const sync = runtime.sync;
    if (!sync) return c.json({ ok: false, error: 'sync unavailable' }, 400);

    const sessionId = body.sessionId || undefined;

    let reconciled = 0;
    try {
      reconciled = await reconcileAllPending();
    } catch (error) {
      return c.json({ ok: false, error: 'reconcile failed', detail: String(error) }, 500);
    }
    const stats = await sync.flush();

    const sink = runtime.sink;
    let cold: Record<string, unknown> | null = null;
    if (sink) {
      const coldStats = await sink.drain(sessionId);
      cold = {
        disabled: coldStats.disabled,
        paths: coldStats.paths,
        chunks: coldStats.chunks,
        manifests: coldStats.manifests,
        durationMs: coldStats.durationMs,
      };
    }

    return c.json({
      ok: true,
      reconciled,
      flushed: stats.flushed,
      failed: stats.failed,
      sink: cold,
    });
  });

  fsRoutes(() => runtime.engine, app);

  sysRoutes(
    {
      engine: () => runtime.engine,
      sessions: runtime.sessions,
      executor: () => runtime.executor,
      sync: runtime.sync,
      persistenceFactory: persistenceSelftestFactory,
      coldFactory: coldSelftestFactory,
      environment: runtime.environment,
    },
    app,
  );

  if (runtime.executor) {
    execRoutes({ engine: () => runtime.engine, executor: () => runtime.executor }, app);
  }

  if (runtime.engine && runtime.executor) {
    toolRoutes(
      { engine: runtime.engine, sessions: runtime.sessions, executor: runtime.executor },
      app,
    );
  }

  app.use(async (c, next) => {
    await next();
    const sync = runtime.sync;
    if (!sync) return;
    try {
      await sync.flush();
    } catch (error) {
      // Flush failing means the response was already sent; surface via header.
      c.header('x-sync-status', `flush-failed:${String(error)}`);
    }
  });

  app.all('*', (c) => c.json({ ok: false, error: 'not_found' }, 404));

  return app;
}

export const app = createApp();

export default app;
