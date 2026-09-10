import type { Hono } from 'hono';

const MIGRATION_SQL = `
DROP FUNCTION IF EXISTS public.claim_job(text);
CREATE OR REPLACE FUNCTION public.claim_job(p_worker_id text)
RETURNS SETOF public.jobs
LANGUAGE sql
VOLATILE
SECURITY DEFINER
AS $$
  UPDATE public.jobs
  SET    state      = 'claimed',
         claimed_by = p_worker_id,
         updated_at = now()
  WHERE  job_id = (
    SELECT job_id
    FROM   public.jobs
    WHERE  state = 'queued'
    ORDER  BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT  1
  )
  RETURNING *;
$$;

DROP FUNCTION IF EXISTS public.requeue_stale_jobs(integer, integer);
CREATE OR REPLACE FUNCTION public.requeue_stale_jobs(
  p_ttl_ms       integer DEFAULT 600000,
  p_max_attempts integer DEFAULT 3
)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
AS $$
  WITH stale AS (
    SELECT job_id
    FROM   public.jobs
    WHERE  state IN ('claimed', 'running')
    AND    updated_at < now() - (p_ttl_ms || 'ms')::interval
    FOR UPDATE SKIP LOCKED
  ),
  requeued AS (
    UPDATE public.jobs
    SET    state      = CASE
             WHEN attempts + 1 >= p_max_attempts THEN 'failed'
             ELSE 'queued'
           END,
           claimed_by = NULL,
           attempts   = attempts + 1,
           updated_at = now()
    FROM   stale
    WHERE  jobs.job_id = stale.job_id
    RETURNING jobs.job_id
  )
  SELECT count(*)::integer FROM requeued;
$$;
`;

async function runMigration(dbUrl: string): Promise<{ ok: boolean; error?: string }> {
  const { Client } = await import('pg');
  const url = dbUrl.includes('sslmode=')
    ? dbUrl
    : `${dbUrl}${dbUrl.includes('?') ? '&' : '?'}sslmode=no-verify`;
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(MIGRATION_SQL);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    await client.end();
  }
}

export function debugRoutes(app: Hono): void {
  app.get('/api/sys/debug-env', (c) => {
    return c.json({
      ok: true,
      data: {
        SUPABASE_URL: process.env.SUPABASE_URL ?? 'NOT_SET',
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
          ? `SET (${process.env.SUPABASE_SERVICE_ROLE_KEY.slice(0, 4)}...)`
          : process.env.SUPABASE_SERVICE_KEY
            ? `SET (${process.env.SUPABASE_SERVICE_KEY.slice(0, 4)}...)`
            : 'NOT_SET',
        BRIDGE_URL: process.env.BRIDGE_URL ?? 'NOT_SET',
        BRIDGE_TOKEN: process.env.BRIDGE_TOKEN
          ? `SET (${process.env.BRIDGE_TOKEN.slice(0, 4)}...)`
          : 'NOT_SET',
        BRIDGE_CHANNEL_ID: process.env.BRIDGE_CHANNEL_ID ?? 'NOT_SET',
        DATABASE_URL: process.env.DATABASE_URL ? 'SET' : 'NOT_SET',
        POSTGRES_URL_NON_POOLING: process.env.POSTGRES_URL_NON_POOLING
          ? `SET (${process.env.POSTGRES_URL_NON_POOLING.slice(0, 20)}...)`
          : 'NOT_SET',
        POSTGRES_PRISMA_URL: process.env.POSTGRES_PRISMA_URL ? 'SET' : 'NOT_SET',
        POSTGRES_URL: process.env.POSTGRES_URL ? 'SET' : 'NOT_SET',
      },
    });
  });

  app.get('/api/sys/debug-env-full', (c) => {
    const key = c.req.query('key');
    if (key !== 'mycomputer-debug') {
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }
    return c.json({
      ok: true,
      data: {
        SUPABASE_URL: process.env.SUPABASE_URL ?? null,
        SUPABASE_SERVICE_ROLE_KEY:
          process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? null,
        BRIDGE_URL: process.env.BRIDGE_URL ?? null,
        BRIDGE_TOKEN: process.env.BRIDGE_TOKEN ?? null,
        BRIDGE_CHANNEL_ID: process.env.BRIDGE_CHANNEL_ID ?? null,
      },
    });
  });

  app.get('/api/sys/migrate', async (c) => {
    const key = c.req.query('key');
    if (key !== 'mycomputer-debug') {
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const dbUrl =
      process.env.DATABASE_URL ??
      process.env.POSTGRES_URL_NON_POOLING ??
      process.env.POSTGRES_PRISMA_URL;

    if (!dbUrl) {
      return c.json(
        {
          ok: false,
          error: 'No database URL found in environment',
          hint: 'Set DATABASE_URL or POSTGRES_URL_NON_POOLING on Vercel',
        },
        500,
      );
    }

    const result = await runMigration(dbUrl);
    if (result.ok) {
      return c.json({ ok: true, message: 'Migration 0004 applied successfully' });
    }
    return c.json({ ok: false, error: result.error }, 500);
  });
}
