import { Hono } from 'hono';
import { execRoutes } from './routes/exec.js';
import { fsRoutes } from './routes/fs.js';
import { sysRoutes } from './routes/sys.js';
import { toolRoutes } from './routes/tools.js';
import { getRuntime, persistenceSelftestFactory, reconcileAllPending } from './runtime.js';

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
    const sync = runtime.sync;
    if (!sync) return c.json({ ok: false, error: 'sync unavailable' }, 400);
    let reconciled = 0;
    try {
      reconciled = await reconcileAllPending();
    } catch (error) {
      return c.json({ ok: false, error: 'reconcile failed', detail: String(error) }, 500);
    }
    const stats = await sync.flush();
    return c.json({ ok: true, reconciled, flushed: stats.flushed, failed: stats.failed });
  });

  fsRoutes(() => runtime.engine, app);

  sysRoutes(
    {
      engine: () => runtime.engine,
      sessions: runtime.sessions,
      executor: () => runtime.executor,
      sync: runtime.sync,
      persistenceFactory: persistenceSelftestFactory,
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
