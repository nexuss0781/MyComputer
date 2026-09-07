# My-Computer — TODO

Live checklist. Check boxes off as work completes. Source of truth for status;
break down further into issues/tasks in the tracker as needed.

Legend: `[ ]` pending · `[x]` done · `[~]` in progress

---

## Phase 1 — Scaffold

- [ ] pnpm workspaces + Turborepo root
- [ ] TypeScript 5 strict config, shared tsconfig base
- [ ] Biome setup (lint + format) wired into CI
- [ ] Vitest at root and per package
- [ ] `shared/` package: zod + types skeleton + bridge contract stubs
- [ ] `app/` Hono app on Vercel Functions
- [ ] `vercel.json`: Node 22, maxDuration policy
- [ ] `services/worker/` scaffold
- [ ] `sdk/` package scaffold
- [ ] `db/migrations/`: sessions, inodes, blocks, operations, executions, jobs
- [ ] Indexes + append-only trigger on `operations`
- [ ] `.env.example` + env loader
- [ ] GitHub Actions CI: typecheck + lint + test

## Phase 2 — FS Engine

- [ ] `oplog` — append-only journal
- [ ] `fs-engine` — buffer + Supabase-backed virtual tree
- [ ] op resolution chain (buffer → Supabase → miss)
- [ ] ops: write, read, append, mkdir, list, move, copy, delete, stat, checksum
- [ ] path normalization + `..` guard, per-session scope
- [ ] content chunking (`MAX_CHUNK_BYTES`) + block allocation
- [ ] routes `/api/fs/*` (10 endpoints), zod-validated
- [ ] `/api/sys/session` create/list
- [ ] unit tests: fs-engine in-memory
- [ ] integration tests: op lifecycle through Hono

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

- [ ] Bridge base URL + auth (from hosted bot server owner)
- [ ] Supabase project provisioned + service key
- [ ] Telegram private channel credentials/access for bridge
- [ ] Vercel project + Actions-enabled GitHub repo