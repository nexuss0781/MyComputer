import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('app routes', () => {
  const app = createApp();

  it('ping responds ok', async () => {
    const res = await app.request('/api/sys/ping');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      service: 'my-computer',
      route: '/api/sys/ping',
    });
  });

  it('unknown routes return 404 JSON', async () => {
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ ok: false, error: 'not_found' });
  });
});
