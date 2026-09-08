-- 0002_sync_state.sql
-- Reconcile watermark for the batch SyncWriter. operations is append-only
-- (no watermark column), so the ingest pointer lives here.
-- Idempotent: safe to run repeatedly (CREATE ... IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS public.sync_state (
  session_id  uuid PRIMARY KEY REFERENCES public.sessions(id),
  flushed_at  timestamptz NOT NULL
);

-- Used by reconcile to find every operation newer than a session's watermark.
CREATE INDEX IF NOT EXISTS idx_operations_reconcile
  ON public.operations (session_id, created_at);