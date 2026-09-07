import { Hono } from 'hono';

export function createApp(): Hono {
  const app = new Hono();

  app.get('/api/sys/ping', (c) =>
    c.json({
      ok: true,
      service: 'my-computer',
      route: '/api/sys/ping',
    }),
  );

  app.all('*', (c) => c.json({ ok: false, error: 'not_found' }, 404));

  return app;
}

export const app = createApp();
