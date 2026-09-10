import { loadEnv } from '@mycomputer/shared';
import type { Hono } from 'hono';

export function debugRoutes(app: Hono): void {
  app.get('/api/sys/debug-env', (c) => {
    const env = loadEnv();
    return c.json({
      ok: true,
      data: {
        SUPABASE_URL: env.SUPABASE_URL ?? 'NOT_SET',
        SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY
          ? `SET (${env.SUPABASE_SERVICE_ROLE_KEY.slice(0, 4)}...)`
          : env.SUPABASE_SERVICE_KEY
            ? `SET (${env.SUPABASE_SERVICE_KEY.slice(0, 4)}...)`
            : 'NOT_SET',
        BRIDGE_URL: env.BRIDGE_URL ?? 'NOT_SET',
        BRIDGE_TOKEN: env.BRIDGE_TOKEN ? `SET (${env.BRIDGE_TOKEN.slice(0, 4)}...)` : 'NOT_SET',
        BRIDGE_CHANNEL_ID: env.BRIDGE_CHANNEL_ID ?? 'NOT_SET',
        DATABASE_URL: process.env.DATABASE_URL ? 'SET' : 'NOT_SET',
      },
    });
  });

  app.get('/api/sys/debug-env-full', (c) => {
    const key = c.req.query('key');
    if (key !== 'mycomputer-debug') {
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }
    const env = loadEnv();
    return c.json({
      ok: true,
      data: {
        SUPABASE_URL: env.SUPABASE_URL ?? null,
        SUPABASE_SERVICE_ROLE_KEY:
          env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_KEY ?? null,
        BRIDGE_URL: env.BRIDGE_URL ?? null,
        BRIDGE_TOKEN: env.BRIDGE_TOKEN ?? null,
        BRIDGE_CHANNEL_ID: env.BRIDGE_CHANNEL_ID ?? null,
      },
    });
  });
}
