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
- [x] `oplog` — append-only journal writer/reader (RPC-backed)
- [x] `fs-engine` — in-memory buffer + Supabase-backed virtual tree
- [x] op resolution: read from buffer → miss → Supabase → miss → error
- [x] ops: `write` (create/overwrite), `read` (range), `append` (O(1) last block),
       `mkdir` (recursive), `list` (by parent), `move`, `copy`, `delete`,
       `stat`, `checksum`
- [x] path normalization + traversal guard (no `..` escape, per-session scope)
- [x] content chunking policy (`MAX_CHUNK_BYTES`) — block allocation + seq

Routes (`/api/fs/*`):
- [x] write, read, append, mkdir, list, move, copy, delete, stat, checksum
- [x] zod-validated request/response on every route
- [x] `/api/sys/session` create/list

Tests:
- [x] unit: fs-engine on in-memory backend
- [x] integration: full op lifecycle through Hono (test env Supabase)

**Exit:** agent can create, read, list, move, copy, delete files; all ops journaled.

**Status: COMPLETE** — live proof (`docs/TODO.md` P2 exit report): prod selftest
`14/14` on Vercel+Supabase, `journalOps 33`, byte-identical multi-block round-trip,
traversal guard 400, every mutating op journaled.

---

## Phase 3 — Agent Tool Surface (Ethco-compatible Terminal)

**Goal:** execute commands through the agent tool bridge with per-session,
env-isolated, journaled semantics, persisted to `executions`.

- [x] `executor` — `child_process.spawn`, cwd = session scratch on `/tmp`
- [x] capture stdout/stderr streaming into `executions` (RPC; 4 MiB cap)
- [x] env isolation (allowlist), timeout cap (30s default / 120s max), signal on abort
- [x] exit code + duration persisted (`timedOut`/`truncated` inferred on read)
- [x] route `/api/exec/run`, `/api/exec/log` (paginate captured output, replay by `execId`)
- [x] journal linkage: exec op → `exec_id` (op_type `exec`)
- [x] `run_command` tool (Ethco shape) backed by the executor; `read`/`edit` aliases

Tests:
- [x] unit: executor against fixture commands, env isolation, timeout kill, stores
- [x] integration: run + log + tool persistence via Hono; selftest 14 → 18 suites

**Exit:** `exec/run` returns output with exit code; output replayable via `exec/log`;
`run_command` persists every call.

**Status: COMPLETE** — live proof: prod selftest `18/18` on Vercel+Supabase (`journalOps 34`),
`exec/run` → `exec/log` replay round-trip (v24.19.0), tool run persisted under
`ethco-workspace`, DELETE session clears executions while preserving the immutable
journal (append-only FK). Local: 35 app tests green, gates clean.

**→ Milestone M1.**

---

## Phase 4 — Quick Persistence (sub-ms hot path)

**Goal:** durable hot writes via batched flushes to Supabase.

- [x] `sync.SyncWriter` — batch buffer + priority-ordered drain (session deletes →
       inode upsert → block delete → block insert → exec upsert), O(1) RPC rounds,
       retry-with-backoff; buffer retained on partial failure
- [x] `sync-supabase.SupabaseSyncTarget` — multi-row upserts/inserts/deletes for
       `inodes`, `blocks`, `executions`; `SupabaseSyncStateStore` + migration
       `0002_sync_state.sql` (`sync_state` flush watermark)
- [x] `operations` journal write stays immediate (RPC), never batched-delayed;
       fs-engine is journal-first: compute (reads) → journal RPC → enqueue apply
- [x] flush trigger: time interval (background timer) + explicit `/api/sys/fsync`;
       post-handler hook flushes before the response returns
- [x] ack semantics: op acks after journal + on-buffer (durable on flush)
- [x] retry with backoff on supabase failure; buffer is in-memory, journal is truth
- [x] `BatchBackend` overlay adapter (read-after-write consistent, mutation enqueue)
- [x] `reconcileFromJournal` — replay write/append content ops past the watermark,
       idempotent; watermark advances per flushed op so deletes are never resurrected
- [x] journal `write`/`append` input carries `{ path, bytes, mime, content(base64) }`
- [x] `BufferedExecStore` — exec results ride the batch flush, replay via cold store

Tests:
- [x] unit: `sync.test.ts` — O(1) round collapse, overlay reads, buffer retention,
       reconcile idempotence + no exec replay, per-path block replacement
- [x] persistence selftest (4 suites): cold-read byte durability, idempotent
       reconcile, exec durability, 50-write single batch flush timing
- [x] prod proof: selftest `22/22` (incl. persistence 4/4, batch flush **106 ms**,
       `journalOps 34`); live write→append→fsync→stat/read→delete→session-cleanup
       round-trip with matching checksums; fsync steady-state idempotent (0 replay)

**Exit:** flush target ~1–10 ms/batch; no data accepted by client is lost in
crash scenarios (journal replay proves it).

**Status: COMPLETE** — live proof: `/api/sys/selftest` `22/22` on Vercel+Supabase
(`journalOps 34`), persistence `4/4`, 50-row batch flush `106 ms`. Live round-trip
`/api/fs/write`(6B) → append(12B) → `/api/sys/fsync` → stat/read (size 12, matching
sha256) → delete → DELETE session (`journalPreserved:true`). fsync idempotent:
71 replay on first backfill, 0 steady-state. Local: 45 app tests green, gates clean.
Commits: `74f9fb2` (feat), `fc3fa01` (watermark idempotence + no exec replay),
`3f18d9e` (per-path block replace fix).

**→ Milestone M2.**

---

## Phase 5 — Telegram Sink (full persistence)

**Goal:** content stored forever on Telegram via the hosted bridge.

- [x] bridge client (in `shared/`): `upload` (`sendDocument` multipart), `download`
      (`getFile` + `/file/bot{token}/{path}`), sha256 verify, retry/backoff on 429/5xx
- [x] chunk upload (streamed multipart, no full-file buffering in function)
- [x] backfill `blocks.tg_msg_id` + `file_id` after upload ack (`migration 0003`)
- [x] dirty walker: `sync/telegram-sink` — async drain of dirty blocks (`tg_msg_id IS NULL`),
      idempotent (annotated chunks never re-upload), in-seq order per path
- [x] cold read path: `ColdBackend` on `fs/read` → hot data empty → sink restore →
      reassemble → checksum verify
- [x] `/api/sys/fsync` — forces full-persist of dirty paths + returns sink stats
- [x] retry/backoff on failed upload; never re-order chunks

Tests:
- [x] contract-mock integration (fake bridge + MockBridge in app selftest) → sink completes uploads
- [x] large file crossing `MAX_CHUNK_BYTES` → stored → restored byte-identical (multi-chunk in order)

**Status: COMPLETE** — live proof: `/api/sys/selftest` `26/26` on Vercel+Supabase
(`cold{4/4,coldVerified:true}`, persistence `4/4`, `flushBatchMs 92`, `journalOps 34`),
then connected to the real bridge (`telegram-bot-api-izqf.onrender.com`) via Vercel envs
`BRIDGE_URL`/`BRIDGE_TOKEN`/`BRIDGE_CHANNEL_ID`. Exit criteria reached.

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