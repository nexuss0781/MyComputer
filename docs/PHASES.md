# My-Computer — Implementation Phases

Working order. Each phase ends runnable and verifiable. Phases fold into the
milestones defined in `docs/ROADMAP.md`.

---

## Phase 1 — Scaffold

**Goal:** repo runs, DB schema exists, CI green.

- [ ] pnpm workspaces + Turborepo root
- [ ] TypeScript 5 strict config, shared tsconfig base
- [ ] Biome setup (`lint`, `format`, in CI)
- [ ] Vitest wired at root and per package
- [ ] `shared/` package: zod deps, base types skeleton, bridge contract stubs
- [ ] `app/` scaffold: Hono app mounted on Vercel Functions (`@vercel/node`)
- [ ] `vercel.json`: Node 22 runtime, `maxDuration` policy
- [ ] `services/worker/` scaffold: same core import target, no logic yet
- [ ] `sdk/` package scaffold: empty typed client
- [ ] `db/migrations/`: schema from `docs/DESIGN.md §3`
  - [ ] `sessions`
  - [ ] `inodes`
  - [ ] `blocks`
  - [ ] `operations`
  - [ ] `executions`
  - [ ] `jobs`
  - [ ] indexes (parent, session, seq) + append-only trigger on `operations`
- [ ] `.env.example` + env loader (Supabase URL/key, bridge URL/token, chunk size)
- [ ] GitHub Actions CI: typecheck + lint + unit tests on push

**Exit:** `pnpm typecheck`, `pnpm lint`, `pnpm test` all green; migrations apply.

---

## Phase 2 — FS Engine

**Goal:** full file operations on the virtual disc, journaled.

`app/core` modules:
- [ ] `oplog` — append-only journal writer/reader (RPC-backed)
- [ ] `fs-engine` — in-memory buffer + Supabase-backed virtual tree
- [ ] op resolution: read from buffer → miss → Supabase → miss → error
- [ ] ops: `write` (create/overwrite), `read` (range), `append` (O(1) last block),
       `mkdir` (recursive), `list` (by parent), `move`, `copy`, `delete`,
       `stat`, `checksum`
- [ ] path normalization + traversal guard (no `..` escape, per-session scope)
- [ ] content chunking policy (`MAX_CHUNK_BYTES`) — block allocation + seq

Routes (`/api/fs/*`):
- [ ] write, read, append, mkdir, list, move, copy, delete, stat, checksum
- [ ] zod-validated request/response on every route
- [ ] `/api/sys/session` create/list

Tests:
- [ ] unit: fs-engine on in-memory backend
- [ ] integration: full op lifecycle through Hono (test env Supabase)

**Exit:** agent can create, read, list, move, copy, delete files; all ops journaled.

---

## Phase 3 — Terminal

**Goal:** execute commands, capture output.

- [ ] `executor` — `child_process.spawn`, cwd = session scratch on `/tmp`
- [ ] capture stdout/stderr streaming into `executions` (typed client or RPC)
- [ ] env isolation, duration cap (mirrors `maxDuration`), signal on abort
- [ ] exit code + duration persisted
- [ ] route `/api/exec/run`, `/api/exec/log` (paginate captured output)
- [ ] journal linkage: exec op → `exec_id`

Tests:
- [ ] unit: executor against fixture commands
- [ ] integration: run + log via Hono

**Exit:** `exec/run` returns output with exit code; output replayable via `exec/log`.

**→ Milestone M1.**

---

## Phase 4 — Quick Persistence (sub-ms hot path)

**Goal:** durable hot writes via batched flushes to Supabase.

- [ ] `sync/supabase-writer` — batch buffer + drain loop
- [ ] multi-row upserts for `inodes`, `blocks`, `executions`
- [ ] `operations` journal write stays immediate (RPC), never batched-delayed
- [ ] flush trigger: size threshold, time interval, explicit `fsync`
- [ ] ack semantics: op acks after journal + on-buffer (durable on flush)
- [ ] retry with backoff on Supabase failure; buffer is in-memory, journal is truth

Tests:
- [ ] benchmark: batch flush time vs row count
- [ ] fault injection: kill flush → reconcile from journal

**Exit:** flush target ~1–10 ms/batch; no data accepted by client is lost in
crash scenarios (journal replay proves it).

---

## Phase 5 — Telegram Sink (full persistence)

**Goal:** content stored forever on Telegram via the hosted bridge.

- [ ] `sync/telegram-sink` — async walker of dirty blocks (`tg_msg_id IS NULL`)
- [ ] bridge client (in `shared/`): `upload`, `bulk`, `manifest`, `download`,
       `manifest get`
- [ ] chunk upload (streamed multipart, no full-file buffering in function)
- [ ] backfill `blocks.tg_msg_id` after upload ack
- [ ] manifest write per path: `path → [msg ids]`
- [ ] cold read path: `fs/read` on old/cold content → bridge download →
       reassemble → checksum verify
- [ ] `/api/sys/fsync` — force full-persist of a path/session
- [ ] retry/backoff on failed upload; never re-order chunks

Tests:
- [ ] contract-mock integration (fake bridge) → sink completes uploads
- [ ] large file via fixtures crossing `MAX_CHUNK_BYTES` → stored → restored byte-identical

**Exit:** write → (async) chunk messages + manifest on channel → cold read
restores exact bytes.

**→ Milestone M2.**

---

## Phase 6 — SDK

**Goal:** agents drive the computer.

- [ ] `@mycomputer/sdk` client: fs + exec + sys surface
- [ ] typed responses from `shared/` schemas
- [ ] streamed read/write helpers (range pagination)
- [ ] session scoping + error mapping
- [ ] example agent script (eat-your-own-dogfood)

Tests:
- [ ] sdk integration against running `app` (local)

**Exit:** a script can `mount` a session and `write`, `exec`, `list` end-to-end.

**→ Milestone M3 (with Phase 7).**

---

## Phase 7 — GH Actions Worker (long-running ops)

**Goal:** ops beyond the CPU window run on GitHub Actions.

- [ ] `jobs` claim helper: atomic queued→claimed, heartbeat, `attempts` cap
- [ ] `services/worker` executor — imports `core`, runs on full runner image
- [ ] `worker.yml`: `workflow_dispatch` + cron poll of `jobs`
- [ ] `/api/sys/dispatch` — write op payload to `jobs`, journal it
- [ ] worker imports outputs to Telegram via bridge sink
- [ ] stale-claim reaper (claim timeout → re-queue)

Tests:
- [ ] dispatch → worker → done, result in journal + Telegram (local + real GH run)

**Exit:** a long op (e.g. small training run) dispatched from the API executes on
GH Actions and reports back through the journal.

**→ Milestone M3.**

---

## Phase 8 — Bench & Harden

**Goal:** prove the targets in `docs/DESIGN.md §9` at scale.

- [ ] `/api/sys/bench` endpoints (latency + throughput harness)
- [ ] hot-path timing: buffer append < 1 ms, Supabase hot read < 10 ms
- [ ] batch flush timing vs row count
- [ ] cold restore timing (bandwidth-limited, intact)
- [ ] multi-GB file through the full pipeline: write → Supabase → Telegram →
       cold restore, checksum-verified
- [ ] recovery drill: crash mid-op → journal replay → consistent tree
- [ ] chunk corruption drill: flip chunk → detected → refetch + alert

**Exit:** benchmark report committed; M4 proof complete.

---

## Completion order checklist

```
P1 ─► P2 ─► P3 ─► P4 ─► P5 ─► P6 ─► P7 ─► P8
      └── M1 ──┘      └── M2 ──┘      └M3┘    └ M4 ┘
```

Dependencies: P4 needs P2 (fs) + P3 (exec). P5 needs P4. P6 needs P2–P5. P7
needs P4 (queue) + P5 (sink). P8 needs everything.