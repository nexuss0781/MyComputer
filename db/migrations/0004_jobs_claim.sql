-- 0004_jobs_claim.sql
-- Atomic job claim + stale requeue via RPC functions.
-- Idempotent: safe to re-run (DROP ... IF EXISTS + CREATE).

-- ---------------------------------------------------------------------------
-- claim_job: atomically claim the next queued job for a worker.
-- Uses FOR UPDATE SKIP LOCKED to avoid contention between concurrent workers.
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- requeue_stale_jobs: reset stale claimed/running jobs to queued.
-- Jobs whose updated_at is older than p_ttl_ms milliseconds are re-queued.
-- Attempts are incremented; if >= p_max_attempts the job is marked failed.
-- Returns the number of requeued jobs.
-- ---------------------------------------------------------------------------

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
