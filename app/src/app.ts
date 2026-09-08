import { Hono } from 'hono';
import { execRoutes } from './routes/exec.js';
import { fsRoutes } from './routes/fs.js';
import { sysRoutes } from './routes/sys.js';
import { toolRoutes } from './routes/tools.js';
import { getRuntime } from './runtime.js';

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

  fsRoutes(() => runtime.engine, app);

  sysRoutes(
    {
      engine: () => runtime.engine,
      sessions: runtime.sessions,
      executor: () => runtime.executor,
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

  app.all('*', (c) => c.json({ ok: false, error: 'not_found' }, 404));

  return app;
}

export const app = createApp();

export default app;
