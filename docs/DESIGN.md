# My-Computer — System Design

## 1. System Overview

My-Computer is a virtual machine for Agentic AI. Compute and storage are fully
decoupled:

- **Vercel Functions** — the CPU. Executes file operations and terminal commands.
- **Supabase Postgres** — hot RAM. Fastest persistence + operation journal + job queue.
- **Telegram private channel + hosted bot bridge** — cold disk. Lifetime,
  immutable, unlimited storage.
- **GitHub Actions worker** — scale-out for long-running operations (AI training).

Every agent action is an **operation**. Operations are journaled, then persisted
twice: first to Supabase (fast, sub-10ms), then to Telegram (forever, unlimited).

```
                    ┌─────────────────────────────────────────────┐
                    │               AGENT (SDK client)            │
                    └───────────────────┬─────────────────────────┘
                                        │ HTTPS
                                        ▼
                    ┌─────────────────────────────────────────────┐
                    │            VERCEL FUNCTIONS (CPU)           │
                    │    Hono router · fs-engine · executor       │
                    │    oplog · batch-buffer · bridge client     │
                    └──────┬──────────────────────┬───────────────┘
                           │ batch upsert         │ chunked upload /
                           │ (hot write)          │ download (cold)
                           ▼                      ▼
                 ┌─────────────────────┐   ┌─────────────────────┐
                 │  SUPABASE (HOT)     │   │  TELEGRAM (COLD)    │
                 │  inodes / blocks    │   │  private channel    │
                 │  operations / exec  │   │  chunks + manifests │
                 │  jobs queue         │   │  via hosted bridge  │
                 └──────────┬──────────┘   └──────────▲──────────┘
                            │ polls                    │
                            ▼                          │
                 ┌─────────────────────────────────────┴─────┐
                 │          GITHUB ACTIONS WORKER            │
                 │  long-running ops / AI training           │
                 └───────────────────────────────────────────┘
```

```
Legend:  -- hot path (sub-ms to ~10ms)     .. cold path (network-bound, seconds)
```

## 2. Architectural Layers

### 2.1 CPU — Vercel Functions

- **Runtime:** Node.js 22 (not Edge — requires `child_process`).
- **Framework:** Hono 4, mounted as Vercel Functions (`/api/*`).
- **Input validation:** zod schemas via `@hono/zod-validator`; every endpoint has
  typed request/response.
- **Scratch space:** `/tmp` is the only writable local filesystem. It is
  ephemeral and per-invocation; it is a scratch pad, never the disc. The virtual
  disc lives in Supabase + Telegram.
- **Duration budget:** inline execution allowed up to `vercel.json`
  `functions.maxDuration`. Ops beyond it are not executed inline — they are
  written to `jobs` and dispatched to the GitHub Actions worker.

### 2.2 Hot RAM — Supabase Postgres

Used for every read on the hot path and as the durability anchor for writes.

- **Client:** `@supabase/supabase-js` with the service role key (server-side only).
- **Write strategy:** multi-row batched upserts. A write that touches N rows is
  one round trip.
- **Journal:** `operations` is append-only, written via RPC, and is the
  crash-recovery source of truth.
- **Queue:** `jobs` doubles as the work queue for the GH Actions worker
  (claim → run → mark done). Simple, durable, no extra infra.

### 2.3 Cold Disk — Telegram via hosted bridge

We do not run the bot. The app talks to a **hosted bridge** over HTTP with a
fixed, contract-first protocol (see §7).

- Every file is stored as **chunks** (each ≤ the channel per-message ceiling,
  well under Telegram's limits).
- A **manifest message** maps `path → [message ids]`. Reading a large file = N
  fetches, enumerated by the manifest. Total storage is effectively unlimited.

### 2.4 Scale-out — GitHub Actions worker

- `worker.yml` triggered by `workflow_dispatch` and/or cron poll.
- Pulls `jobs` rows in claim state, reuses the same `core` modules from the
  monorepo, executes long-running ops (training runs, bulk transforms), and
  writes results back through the bridge → Telegram, then updates `jobs`.

## 3. Data Model

### 3.1 `sessions`

| column   | type      | notes                          |
| -------- | --------- | ------------------------------ |
| id       | uuid PK   |                               |
| name     | text      | agent/computer instance label  |
| created_at | timestamptz |                             |
| meta     | jsonb     | arbitrary instance metadata   |

### 3.2 `inodes` — virtual file tree

| column      | type              | notes                              |
| ----------- | ----------------- | ---------------------------------- |
| path        | text PK           | absolute virtual path              |
| session_id  | uuid FK           | partitioned by session             |
| type        | 'file'\|'dir'    |                                    |
| mode        | integer           | POSIX-like perms (default 0644)    |
| size        | bigint            | bytes                              |
| mime        | text              | content type if known              |
| checksum    | text              | sha256 of full content             |
| parent      | text              | denormalized for fast list/rename  |
| createdAt   | timestamptz       |                                    |
| updatedAt   | timestamptz       |                                    |

### 3.3 `blocks` — content chunks

| column      | type       | notes                             |
| ----------- | ---------- | --------------------------------- |
| content_id  | uuid PK    | one per file content version       |
| path        | text       | owning virtual path                |
| seq         | integer    | ordered chunk index                |
| size        | integer    | chunk byte length                  |
| data        | bytea      | raw bytes (fast hot-read storage)  |
| tg_msg_id   | bigint     | telegram message id (cold read)    |
| checksum    | text       | sha256 per chunk                   |
| session_id  | uuid FK    |                                   |

`PK (content_id, seq)` for ordering. Tumple: hot read uses `data`; cold read
uses `tg_msg_id` to fetch from Telegram.

### 3.4 `operations` — append-only journal

| column    | type            | notes                                   |
| --------- | --------------- | --------------------------------------- |
| op_id     | uuid PK         |                                         |
| session_id| uuid FK         |                                         |
| op_type   | text            | write/read/append/mkdir/move/copy/delete/exec/… |
| input     | jsonb           | op arguments                            |
| result    | jsonb           | op result (or error)                    |
| status    | text            | pending/running/ok/error                |
| parent_op | uuid FK null    | for nested/batched operation trees      |
| created_at| timestamptz     |                                         |
| duration_ms | integer null   |                                        |

Append-only, never updated in place. Recovery = replay from here.

### 3.5 `executions` — terminal runs

| column     | type        | notes                          |
| ---------- | ----------- | ------------------------------ |
| exec_id    | uuid PK     |                                |
| session_id | uuid FK     |                                |
| command    | text        | full command line              |
| cwd        | text        | virtual working directory      |
| stdout     | text/bytea  | captured stream                |
| stderr     | text/bytea  | captured stream                |
| exit_code  | integer n   | null while running             |
| duration_ms| integer     |                                |
| created_at | timestamptz |                                |

### 3.6 `jobs` — long-run queue

| column      | type    | notes                                    |
| ----------- | ------- | ---------------------------------------- |
| job_id      | uuid PK |                                          |
| session_id  | uuid FK |                                          |
| kind        | text    | train/transform/bench/…                  |
| payload     | jsonb   | job definition                          |
| state       | text    | queued/claimed/running/done/failed       |
| claimed_by  | text n  | worker identity                         |
| attempts    | integer | retry counter                           |
| created_at  | timestamptz |                                     |
| updated_at  | timestamptz |                                     |

## 4. Operation Pipeline — Single Write Path

All mutations share one path. Variant content (`data`) is only written on
file-mutating ops (write/append/move/copy).

```
  in-memory buffer ──► 1. EXECUTE (core engine, /tmp scratch)
                            │
                            ▼
                       2. JOURNAL (operations, RPC append)
                            │
                            ▼
                       3. QUICK PERSIST (batch flush → Supabase)
                            │  multi-row upsert: inodes + blocks + executions
                            │  + new files: enqueue async Telegram upload
                            ▼
                       4. FULL PERSIST (Telegram sink, async, out-of-band)
                            ├─ upsert content_id
                            ├─ upload chunk_i → bridge → msg_id
                            ├─ persist tg_msg_id back to blocks
                            └─ write manifest message path → [msg ids]
```

**Step details**

1. **Execute** — handler resolves the op against the virtual FS (from memory
   buffer + Supabase), does real work on `/tmp`, and produces a result.
2. **Journal** — `operations.insert` fires immediately via RPC. If step 3–4 die,
   the journal is the source of truth for recovery/retry.
3. **Quick persist** — the sync writer drains a buffer of accumulated rows and
   flushes in one batched transaction: new/changed `inodes`, any new `blocks`
   `data`, and `executions`. Acking here means the write is durable on the hot
   path.
4. **Full persist** — in-band or queued, the Telegram sink walks dirty
   `blocks` (where `tg_msg_id IS NULL`), uploads each chunk, backfills
   `tg_msg_id`, then posts the manifest. This completes asynchronously —
   the caller never waits on Telegram latency.

## 5. Read Paths

### 5.1 Hot read (Supabase)

1. Resolve `path` → `inode` row.
2. Pick `blocks` rows for the range requested.
3. Return `data` from `blocks`.
Target: **< 10 ms** end-to-end for typical file ranges.

### 5.2 Cold read (Telegram)

1. Resolve `path` → `inode` → manifest message (or stored `tg_msg_id` map).
2. `bridge /download` each chunk message.
3. Reassemble in order, verify per-chunk checksum.
Target: network-bound; **bandwidth-limited, not size-limited**.

### 5.3 Directory listing

`inodes` query by `parent` — one indexed scan (set `parent` index per session).

## 6. API Surface (Vercel CPU)

All endpoints: `POST /api/...` with zod-validated JSON.

### fs
| Endpoint            | Op                  | Notes                              |
| ------------------- | ------------------- | ---------------------------------- |
| `/api/fs/write`     | create/overwrite    | full content, or chunked body      |
| `/api/fs/read`      | read range          | offset/limit for streaming         |
| `/api/fs/append`    | append              | O(1) via last block                |
| `/api/fs/mkdir`     | create dir          | recursive flag                     |
| `/api/fs/list`      | list children       | by parent                          |
| `/api/fs/move`      | rename/move         | path rewrite in inodes             |
| `/api/fs/copy`      | duplicate           |                               |
| `/api/fs/delete`    | remove              | recursive flag                     |
| `/api/fs/stat`      | metadata            | size/mode/checksum/mime            |
| `/api/fs/checksum`  | verify              | sha256 full content                |

### terminal
| Endpoint            | Notes                                |
| ------------------- | ------------------------------------ |
| `/api/exec/run`     | run command, capped duration         |
| `/api/exec/log`     | stream/paginate an exec's captured output |

### system
| Endpoint               | Notes                                        |
| ---------------------- | -------------------------------------------- |
| `/api/sys/session`     | create/list current session                  |
| `/api/sys/ops`         | journal query / replay                       |
| `/api/sys/dispatch`    | queue long-run op → `jobs` for GH worker     |
| `/api/sys/bench`       | latency + throughput harness endpoints       |
| `/api/sys/fsync`       | force full-persist flush for a path/session  |

## 7. Telegram Bridge Contract (client side only)

The hosted bot server exposes an HTTP API. The app implements a typed client
from this contract (in `shared/`).

| Method | Route            | Request                                       | Response            |
| ------ | ---------------- | --------------------------------------------- | ------------------- |
| POST   | `/upload`        | multipart: content_id, seq, bytes, meta       | `{ msg_id }`        |
| POST   | `/manifest`      | JSON: `{ path, session_id, chunks: [msg_id] }` | `{ manifest_msg_id }` |
| GET    | `/download/:msg` | —                                             | raw bytes           |
| GET    | `/manifest/:path`| —                                             | `{ chunks: [...] }` |
| POST   | `/bulk`          | batch of uploads (used on big file writes)    | `[{ seq, msg_id }]` |

- **Auth:** per-request header token (negotiated via env var), shared secret
  between app and bridge.
- **Streaming:** uploads use streamed multipart; no full-file buffering in the
  function.
- **Chunking:** client-side policy — split files ≥ `MAX_CHUNK_BYTES` (configurable,
  default e.g. 8 MB) into sequence-indexed chunks; manifest ties them together.
  The system is agnostic to the ceiling; the bridge guarantees reassembly.

## 8. Long-Run Dispatch (GitHub Actions)

```
  small op ──► inline on Vercel (within duration budget)
  long op  ──► POST /api/sys/dispatch
                  │  payload → jobs (state=queued)
                  ▼
               workflow_dispatch / cron poll
                  │  worker claims job (queued→claimed, atomic)
                  │  runs core executor on runner (full OS image)
                  │  writes outputs via bridge → Telegram
                  ▼
               jobs.state = done/failed, result ref in payload
```

- **Claim semantics:** `UPDATE jobs SET state='claimed' WHERE job_id=? AND state='queued'`
  is atomic; retries on failure with `attempts` cap.
- **Same code, different host:** worker imports `core/` executor. Only the
  runtime image differs (Node 22 + full runner toolchain).
- **Visibility:** op journal (`operations`) records the dispatch; final result
  lands in the journal + Telegram.

## 9. Performance Model & Targets

| Path                     | Target                     | Bound                      |
| ------------------------ | -------------------------- | -------------------------- |
| In-memory buffer append  | < 1 ms (sub-ms)            | local op, no network       |
| Batch flush → Supabase   | ~1–10 ms per batch         | network (single RTT)       |
| Hot read (Supabase)      | < 10 ms                    | Supabase network           |
| Cold read (Telegram)     | bandwidth-limited          | bridge + Telegram CDN      |
| Write durability (hot)   | ≤ batch flush interval     | sync callback to client    |
| Durable forever (cold)   | async, eventual            | Telegram upload finishes   |

No operation is blocked on cold-path latency; cold persistence is out-of-band.

## 10. Failure Modes & Recovery

| Failure                    | Detection                          | Recovery                                   |
| -------------------------- | ---------------------------------- | ------------------------------------------ |
| Function crash mid-op      | journal has `pending` op           | replay journal, reconcile to blocks        |
| Batch flush lost           | retry buffer not acked             | re-run from journal                        |
| Telegram upload fails      | `tg_msg_id` still null             | sink retries dirty blocks; checksum verify |
| Worker dies after claim    | stale `claimed` + heartbeat expiry | claim timeout → re-queue                   |
| Supabase unavailable       | 5xx on flush                       | journal buffers; cold path still serves    |
| Chunk corruption           | per-chunk sha256 mismatch          | refetch chunk from Telegram, alert         |

Recovery order: **journal → blocks (hot) → Telegram (cold)**. The journal is
always the tiebreaker for what the virtual FS should look like.

## 11. Security

- Supabase service-role key lives only in Vercel env; never exposed to agents.
- RLS disabled on persisters, but the API layer governs access per session ID.
- Bridge auth via shared secret header; no agent-facing Telegram access.
- Session boundary: every op carries `session_id`; virtual FS is scoped per
  session (no cross-session path access).
- Content verification: per-chunk + whole-file sha256 on every cold read.
- `/tmp` data is ephemeral and wiped between invocations; nothing secret is
  ever written to scratch.

## 12. Deployment Topology

```
  app/                → Vercel project (Functions, Node 22, env secrets)
  services/worker/    → GitHub Actions workflow (worker.yml) on the repo
  db/                 → migrations applied to Supabase instance
  bot bridge          → externally hosted (provided), contract in shared/
  Telegram channel    → private vault used as storage by the bridge
  sdk/                → published/consumed by agent clients
```

### Env vars (Vercel + worker)
```
SUPABASE_URL=…
SUPABASE_SERVICE_KEY=…
BRIDGE_URL=…
BRIDGE_TOKEN=…
DEFAULT_SESSION_NAME=my-computer
MAX_CHUNK_BYTES=8388608
```

## 13. Packaging

| Package            | Contents                                      |
| ------------------ | --------------------------------------------- |
| `shared/`          | zod schemas, types, bridge client contract, errors |
| `core/` (in app)   | fs-engine, executor, oplog — portable, reused by worker |
| `sdk/`             | `@nexuss0781/mycomputer` client for agents           |
| `db/`              | SQL migrations (schema §3)                     |
| `.github/`         | worker workflow + claim helper                |