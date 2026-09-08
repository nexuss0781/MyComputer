import { Hono } from 'hono';
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
    { engine: () => runtime.engine, sessions: runtime.sessions, environment: runtime.environment },
    app,
  );

  if (runtime.engine) {
    toolRoutes({ engine: runtime.engine, sessions: runtime.sessions }, app);
  }

  app.all('*', (c) => c.json({ ok: false, error: 'not_found' }, 404));

  return app;
}

export const app = createApp();

export default app;
