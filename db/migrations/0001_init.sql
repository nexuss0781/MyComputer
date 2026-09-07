-- 0001_init.sql
-- My-Computer schema: sessions, inodes, blocks, operations, executions, jobs.
-- Idempotent: safe to run repeatedly (CREATE ... IF NOT EXISTS, OR REPLACE).

-- ---------------------------------------------------------------------------
-- sessions — one per agent/computer instance
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  meta       jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.sessions ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- ---------------------------------------------------------------------------
-- inodes — the virtual file tree
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inodes (
  path       text NOT NULL,
  session_id uuid NOT NULL REFERENCES public.sessions(id),
  type       text NOT NULL CHECK (type IN ('file', 'dir')),
  mode       integer NOT NULL DEFAULT 420,  -- 0644
  size       bigint NOT NULL DEFAULT 0,
  mime       text,
  checksum   text,
  parent     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, path)
);
ALTER TABLE public.inodes ALTER COLUMN updated_at SET DEFAULT now();

-- ---------------------------------------------------------------------------
-- blocks — content chunks; hot read via data, cold read via tg_msg_id
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.blocks (
  content_id uuid NOT NULL,
  path       text NOT NULL,
  session_id uuid NOT NULL REFERENCES public.sessions(id),
  seq        integer NOT NULL CHECK (seq >= 0),
  size       integer NOT NULL CHECK (size >= 0),
  data       bytea,
  tg_msg_id  bigint,
  checksum   text,
  PRIMARY KEY (content_id, seq)
);

-- ---------------------------------------------------------------------------
-- operations — append-only journal of every agent action
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.operations (
  op_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES public.sessions(id),
  op_type     text NOT NULL,
  input       jsonb NOT NULL DEFAULT '{}'::jsonb,
  result      jsonb,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'ok', 'error')),
  parent_op   uuid REFERENCES public.operations(op_id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer
);
ALTER TABLE public.operations ALTER COLUMN op_id SET DEFAULT gen_random_uuid();
ALTER TABLE public.operations ALTER COLUMN created_at SET DEFAULT now();

CREATE OR REPLACE FUNCTION public.enforce_operations_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operations is append-only'
    USING ERRCODE = 'feature_not_supported';
END;
$$;

DROP TRIGGER IF EXISTS operations_append_only_update ON public.operations;
CREATE TRIGGER operations_append_only_update
  BEFORE UPDATE ON public.operations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_operations_append_only();

DROP TRIGGER IF EXISTS operations_append_only_delete ON public.operations;
CREATE TRIGGER operations_append_only_delete
  BEFORE DELETE ON public.operations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_operations_append_only();

DROP TRIGGER IF EXISTS operations_append_only_truncate ON public.operations;
CREATE TRIGGER operations_append_only_truncate
  AFTER TRUNCATE ON public.operations
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_operations_append_only();

-- ---------------------------------------------------------------------------
-- executions — terminal runs with captured output
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.executions (
  exec_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES public.sessions(id),
  command     text NOT NULL,
  cwd         text,
  stdout      bytea,
  stderr      bytea,
  exit_code   integer,
  duration_ms integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.executions ALTER COLUMN exec_id SET DEFAULT gen_random_uuid();
ALTER TABLE public.executions ALTER COLUMN created_at SET DEFAULT now();

-- ---------------------------------------------------------------------------
-- jobs — durable queue for long-running work (GH Actions workers pick up)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.jobs (
  job_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sessions(id),
  kind       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  state      text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'claimed', 'running', 'done', 'failed')),
  claimed_by text,
  attempts   integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.jobs ALTER COLUMN job_id SET DEFAULT gen_random_uuid();
ALTER TABLE public.jobs ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.jobs ALTER COLUMN updated_at SET DEFAULT now();

-- ---------------------------------------------------------------------------
-- indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_sessions_created ON public.sessions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inodes_parent ON public.inodes (session_id, parent);
CREATE INDEX IF NOT EXISTS idx_inodes_updated ON public.inodes (session_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_blocks_path ON public.blocks (session_id, path);
CREATE INDEX IF NOT EXISTS idx_blocks_tgmsg ON public.blocks (tg_msg_id) WHERE tg_msg_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operations_session ON public.operations (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operations_status ON public.operations (status);

CREATE INDEX IF NOT EXISTS idx_executions_session ON public.executions (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_state ON public.jobs (state, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_session ON public.jobs (session_id, created_at DESC);