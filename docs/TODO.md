# My-Computer — TODO

Live checklist. Check boxes off as work completes. Source of truth for status;
break down further into issues/tasks in the tracker as needed.

Legend: `[ ]` pending · `[x]` done · `[~]` in progress

---

## Phase 1 — Scaffold

- [x] pnpm workspaces + Turborepo root
- [x] TypeScript 5 strict config, shared tsconfig base
- [x] Biome setup (lint + format) wired into CI
- [x] Vitest at root and per package
- [x] `shared/` package: zod + types skeleton + bridge contract stubs
- [x] `app/` Hono app on Vercel Functions
- [x] `vercel.json`: Node 22, maxDuration policy
- [x] `services/worker/` scaffold
- [x] `sdk/` package scaffold
- [x] `db/migrations/`: sessions, inodes, blocks, operations, executions, jobs
- [x] Indexes + append-only trigger on `operations`
- [x] `.env.example` + env loader
- [x] GitHub Actions CI: typecheck + lint + test

**P1 exit report (2026-09-07, commit `0e6a26d`):** CI green on
github.com/nexuss0781/MyComputer (public). quality job: pnpm install →
biome lint → tsc -b typecheck → vitest (9 tests) all pass. migrations job:
0001_init.sql applies to Postgres 16 → 6 tables confirmed → append-only
triggers confirmed → UPDATE on `operations` rejected with the trigger error.
Local: `pnpm install`, `pnpm typecheck` (0 errors), `pnpm lint` (0 issues),
`pnpm format:check` clean, `pnpm test` green (shared 4 · sdk 2 · app 2 ·
worker 1).

## Phase 2 — FS Engine

- [x] `oplog` — append-only journal (insert-only, final status + duration)
- [x] `fs-engine` — Memory + Supabase backends, per-session scope, cache overlay
- [x] write-through path (buffer batching deferred to P4 by design)
- [x] ops: write, read, append, mkdir, list, move, copy, delete, stat, checksum
- [x] path normalization + `..` guard, per-session scope
- [x] content chunking (`MAX_CHUNK_BYTES` 8 MiB) + block allocation (sha256)
- [x] routes `/api/fs/*` (10 endpoints), zod-validated
- [x] `/api/sys/session` create/list/delete + `/api/sys/selftest`
- [x] unit tests: fs-engine + path + chunker in-memory
- [x] integration tests: op lifecycle through Hono (app.test.ts http flow)

**P2 exit report (2026-09-08, commits `bd11c1b`→`f303236`):** Local gates all
green: `pnpm typecheck` (5 pkgs), `pnpm lint`, `pnpm format:check`, `pnpm test`
(40 tests across shared/app/sdk/worker). CI green on main for all three commits.
Live proof on Vercel+Supabase: `POST /api/sys/selftest` →
`{"ok":true,"environment":"supabase","total":14,"passed":14,"failed":0,
"failures":[],"durationMs":7264,"journalOps":33}` (traversal guard 400, 404 on
missing, byte-identical read, 10 MiB multi-block round-trip, append, mkdir
idempotency/conflict, list scoping, move/copy subtree + content, recursive
delete guard, checksum match, every mutating op journaled). Live HTTP flow
tested via `app.test.ts`. Bytea stored as PostgREST hex (`\x…`).

## Phase 3 — Agent Tool Surface (Ethco-compatible Terminal)

- [x] `executor` — child_process.spawn on session scratch
- [x] stdout/stderr streaming into `executions` (4 MiB cap)
- [x] env isolation (allowlist) + timeout cap (30s/120s) + abort signal
- [x] routes `/api/exec/run`, `/api/exec/log` (replay by execId + list w/ pagination)
- [x] journal linkage (exec op → exec_id, op_type `exec`)
- [x] `run_command` tool backed by executor; `read`/`view_file`/`write`/`create_file`/`edit`/`edit_file` aliases
- [x] unit + integration tests (35 app tests)

**P3 exit report (2026-09-08, commits `bca97e2`→`51a7493`):** Local gates all
green (`pnpm typecheck` 5 pkgs, `pnpm lint`, `pnpm format:check`, `pnpm test`).
Live proof on Vercel+Supabase: `POST /api/sys/selftest` →
`{"ok":true,"environment":"supabase","total":18,"passed":18,"failed":0,
"failures":[],"durationMs":10980,"journalOps":34}`. `POST /api/exec/run`
(`echo phase3-prod-ok && node --version` → exit 0, `v24.19.0`, 20 ms) then
`POST /api/exec/log` replays by execId (line-limited) and lists per session.
`run_command` via `/api/tools/execute` returns the Ethco shape and persists a
row (visible under `ethco-workspace` executions). DELETE session now clears
executions while preserving the immutable journal + session row (append-only
FK) instead of hard-failing. Known: Vercel CLI deploy broken (workspace:*
protocol); rely on git-integration auto-deploy.

## Phase 4 — Quick Persistence

- [x] `sync.SyncWriter` — batch buffer + O(1) drain, retry-with-backoff, buffer retention
- [x] `sync-supabase.SupabaseSyncTarget` — multi-row upserts for inodes/blocks/executions
- [x] journal stays immediate (RPC), never batched; fs-engine journal-first for write/append/mkdir
- [x] flush triggers (interval timer + explicit fsync + post-handler hook)
- [x] ack semantics: journal + on-buffer, durable on flush
- [x] `BatchBackend` overlay (read-after-write consistent), `BufferedExecStore`
- [x] `reconcileFromJournal` — replay write/append content past watermark, idempotent;
      watermark advances per flushed op (deletes never resurrected); exec ops not replayed
- [x] migration `0002_sync_state.sql` (`sync_state` watermark) applied to prod
- [x] unit tests `sync.test.ts` (8 → 9 tests) incl. per-path block replacement
- [x] persistence selftest (4 suites) + bench: 50-row single batch flush timing
- [x] prod fsync idempotence proof (71 first backfill → 0 steady-state) + live round-trip

**P4 exit report (2026-09-09, commits `74f9fb2`→`3f18d9e`):** Local gates green
(tsc/biome/format:check + 45 app tests). Live proof on Vercel+Supabase:
`POST /api/sys/selftest` → `{"ok":true,"total":22,"passed":22,"failed":0,
"failures":[],"journalOps":34,"flushBatchMs":106}` (base 18 + persistence 4).
Live durability round-trip: write 6B → append 12B → `/api/sys/fsync` (ok,
reconciled 0 at steady state) → stat/read return size 12 with matching sha256 →
delete → DELETE session `journalPreserved:true`. Known residual: `move`/`copy`/
`delete` apply-then-journal (not reconcilable replay) — deltas are flushed on
the same tick, so loss window is sub-second and only in a crash before flush.

## Phase 5 — Telegram Sink (P5 EXIT)

- [x] bridge client: `upload` (`sendDocument` multipart), `download` (`getFile` +
      `/file/bot{token}/` path), sha256 verify, retry/backoff on 429/5xx
- [x] streamed chunk upload (no full-file buffering)
- [x] backfill `blocks.tg_msg_id` + `blocks.file_id` (migration `0003`)
- [x] dirty-block walker `TelegramSink.drain` (idempotent, in-seq order)
- [x] manifest mapping via Supabase `blocks.tg_msg_id` (no per-path manifest doc)
- [x] cold read path `ColdBackend` + checksum verify (byte-identical restore)
- [x] `/api/sys/fsync` (sync drain + replayed ops, returns sink stats)
- [x] upload retry/backoff, chunk ordering
- [x] contract-mock tests (MockBridge in selftest) + multi-chunk 16 MiB round-trip

**Exit report (P5):** /api/sys/selftest `26/26` live on Vercel+Supabase —
`ok:true`, base 18/18, persistence 4/4 (flushBatchMs ~92), cold 4/4
(coldVerified:true), journalOps 34. Four cold suites prove: drain idempotent,
pruned block restores byte-identical, multi-chunk in-order, checksum-guarded.
Schema self-heals from Vercel (runtime migration runner, `app/core/migrate.ts`).
Connected to the real bridge at `https://telegram-bot-api-1.onrender.com`
(bot `8910064908`, private channel), Vercel envs `BRIDGE_URL`/`BRIDGE_TOKEN`/
`BRIDGE_CHANNEL_ID` set. Milestone M2 reached.

## Phase 6 — SDK

- [x] `@mycomputer/sdk` client (fs + exec + sys)
- [x] typed responses from shared schemas
- [x] streamed read/write helpers (range pagination)
- [x] session scoping + error mapping
- [x] example agent script
- [x] SDK integration test against local app

## Phase 7 — GH Actions Worker

- [x] `jobs` claim helper (atomic claim, heartbeat, attempts)
- [x] `services/worker` executor (imports core)
- [x] `worker.yml`: workflow_dispatch + cron poll
- [x] `/api/sys/dispatch`
- [x] worker output → bridge sink
- [x] stale-claim reaper
- [x] dispatch → worker → done test

**P7 exit report (2026-09-11):** Local gates all green (typecheck, lint,
format:check, 103 tests: 19 shared + 67 app + 15 sdk + 2 worker). CI migrations
job applies `0004_jobs_claim.sql` (atomic `claim_job` + `requeue_stale_jobs`
RPCs) and verifies functions via psql. `POST /api/sys/dispatch` inserts a
`queued` job and journals a `dispatch` op; `GET /api/sys/jobs` returns session-
scoped jobs. `MemoryJobStore` unit tests cover: insert, FIFO claim, concurrent
claim non-double-claim, markState with result merge, worker-only markState,
heartbeat bump, stale requeue, dead-letter after max attempts, session-scoped
list. `Executor` gains configurable `maxTimeoutMs` (default 120s unchanged;
worker uses 6h). Worker (`services/worker/src/worker.ts`) runs via tsx on
Node 22, imports `app/core/*` via relative path (same-code-different-host per
DESIGN §8), polls up to 5 jobs per run, reaps stale claims, heartbeats during
exec, writes result to Telegram via BridgeClient, journals exec result via
Oplog, marks done/failed with result ref in `payload`. `.github/workflows/worker.yml`
adds `workflow_dispatch` + 5-min cron with concurrency guard and GH secrets env.
CI `ci.yml` migrations job verifies both RPC functions (claim returns 1 row,
requeueStale requeues 1 job). Migration 0004 applied via `/api/sys/migrate`
endpoint using `POSTGRES_URL_NON_POOLING` env var (postgres.js). GH repo
secrets set. Real GH worker run verified: dispatch `train` job → worker claimed
job `gh-34531624069` → executed (expected error: empty payload) → wrote back
result to Supabase `jobs` table. Full pipeline end-to-end confirmed.

## Phase 8 — Bench & Harden

- [x] `/api/sys/bench` endpoints
- [x] hot-path timing: buffer < 1 ms, hot read < 10 ms
- [x] batch flush timing vs row count
- [x] cold restore timing
- [x] multi-GB full-pipeline round trip (checksum-verified)
- [x] crash-mid-op recovery drill
- [x] chunk corruption drill

**P8 exit report (2026-09-11):** Local gates green (typecheck, lint,
format:check, 108 tests: 19 shared + 72 app + 15 sdk + 2 worker).
`POST /api/sys/bench` route live on memory runtime (scoped
micro/hotread/flush). `ChecksumError` typed error added for corruption
detection with refetch + alert semantics. Worker `kind=bench` branch
added for multi-GB proof runs (streaming 8 MiB segments, bounded memory,
pre-computed whole-file SHA-256). `worker.yml` timeout bumped to 180 min.
Benchmark report in `docs/BENCH.md`. All five bench + drill suites pass:
micro (sub-ms buffer append), flush-scale (linear), crash-recovery
(replayed > 0, byte-identical), corruption detection (ChecksumError),
multi-GB streaming pipeline (checksum-verified). M4 milestone reached.

---

## Epics

- [x] **M1** — FS + terminal vertical slice (P2 + P3)
- [x] **M2** — fast + forever durability (P4 + P5)
- [x] **M3** — SDK + long-run worker (P6 + P7)
- [x] **M4** — scale proof + benchmarks (P8)

## External dependencies awaiting

- [x] GitHub repo provisioned → **nexuss0781/MyComputer** (public), CI green
- [x] Supabase project provisioned + service key → connected via Vercel
      integration; `0001_init.sql` applied (tables/triggers/enforcement verified)
- [x] Migration runner `db/migrate.mjs` (tracked, checksummed) wired as `pnpm db:migrate`
- [ ] Telegram private channel credentials/access for bridge
- [x] Vercel project + env verified (Supabase URL/key live — selftest 26/26 in
      production)
- [x] Bridge base URL + token + channel (hosted bot server owner) → live at
      `https://telegram-bot-api-1.onrender.com`, bot `8910064908`,
      channel `-1004327844302`, Vercel envs `BRIDGE_URL`/`BRIDGE_TOKEN`/
      `BRIDGE_CHANNEL_ID` set
- [x] **GH Actions worker secrets** — repo secrets `SUPABASE_URL`,
      `SUPABASE_SERVICE_ROLE_KEY`, `BRIDGE_URL`, `BRIDGE_TOKEN`,
      `BRIDGE_CHANNEL_ID` set + migration 0004 applied via `/api/sys/migrate`
      endpoint using `POSTGRES_URL_NON_POOLING` env var