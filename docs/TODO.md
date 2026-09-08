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

## Phase 3 — Terminal

- [ ] `executor` — child_process.spawn on session scratch
- [ ] stdout/stderr streaming into `executions`
- [ ] env isolation + duration cap + abort signal
- [ ] routes `/api/exec/run`, `/api/exec/log`
- [ ] journal linkage (exec op → exec_id)
- [ ] unit + integration tests

## Phase 4 — Quick Persistence

- [ ] `sync/supabase-writer` — batch buffer + drain loop
- [ ] multi-row upserts: inodes, blocks, executions
- [ ] journal stays immediate (RPC), never batched
- [ ] flush triggers (size / interval / explicit fsync)
- [ ] ack semantics + retry with backoff
- [ ] bench: flush time vs row count
- [ ] fault-injection test: crash → journal reconcile

## Phase 5 — Telegram Sink

- [ ] `sync/telegram-sink` — dirty-block walker
- [ ] bridge client: upload, bulk, manifest, download, manifest get
- [ ] streamed chunk upload
- [ ] backfill `blocks.tg_msg_id`
- [ ] manifest write per path
- [ ] cold read path + checksum verify
- [ ] `/api/sys/fsync`
- [ ] upload retry/backoff, chunk ordering
- [ ] contract-mock tests + large-file round-trip test

## Phase 6 — SDK

- [ ] `@mycomputer/sdk` client (fs + exec + sys)
- [ ] typed responses from shared schemas
- [ ] streamed read/write helpers (range pagination)
- [ ] session scoping + error mapping
- [ ] example agent script
- [ ] SDK integration test against local app

## Phase 7 — GH Actions Worker

- [ ] `jobs` claim helper (atomic claim, heartbeat, attempts)
- [ ] `services/worker` executor (imports core)
- [ ] `worker.yml`: workflow_dispatch + cron poll
- [ ] `/api/sys/dispatch`
- [ ] worker output → bridge sink
- [ ] stale-claim reaper
- [ ] dispatch → worker → done test

## Phase 8 — Bench & Harden

- [ ] `/api/sys/bench` endpoints
- [ ] hot-path timing: buffer < 1 ms, hot read < 10 ms
- [ ] batch flush timing vs row count
- [ ] cold restore timing
- [ ] multi-GB full-pipeline round trip (checksum-verified)
- [ ] crash-mid-op recovery drill
- [ ] chunk corruption drill

---

## Epics

- [ ] **M1** — FS + terminal vertical slice (P2 + P3)
- [ ] **M2** — fast + forever durability (P4 + P5)
- [ ] **M3** — SDK + long-run worker (P6 + P7)
- [ ] **M4** — scale proof + benchmarks (P8)

## External dependencies awaiting

- [x] GitHub repo provisioned → **nexuss0781/MyComputer** (public), CI green
- [x] Supabase project provisioned + service key → connected via Vercel
      integration; `0001_init.sql` applied (tables/triggers/enforcement verified)
- [x] Migration runner `db/migrate.mjs` (tracked, checksummed) wired as `pnpm db:migrate`
- [ ] Telegram private channel credentials/access for bridge
- [x] Vercel project + env verified (Supabase URL/key live — selftest 14/14 in
      production; bridge URL/token still awaiting)
- [ ] Bridge base URL + auth (from hosted bot server owner)