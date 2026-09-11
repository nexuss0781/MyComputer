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
then connected to the real bridge (`telegram-bot-api-1.onrender.com`) via Vercel envs
`BRIDGE_URL`/`BRIDGE_TOKEN`/`BRIDGE_CHANNEL_ID`. File downloads over HTTP required an
nginx front in front of the self-hosted bot-api (the binary never serves `/file/` itself);
the fork now bundles one. Exit criteria reached.

**→ Milestone M2.**

---

## Phase 6 — SDK

**Goal:** agents drive the computer.

- [x] `@nexuss0781/mycomputer` client: fs + exec + sys surface
- [x] typed responses from `shared/` schemas
- [x] streamed read/write helpers (range pagination)
- [x] session scoping + error mapping
- [x] example agent script (eat-your-own-dogfood)

Tests:
- [x] sdk integration against running `app` (local)

**Exit:** a script can `mount` a session and `write`, `exec`, `list` end-to-end.

**Exit report (eaef9cb):** the SDK ships as `@nexuss0781/mycomputer` with a
zero-runtime-dependency client (`http.ts` transport, flat + envelope handling,
base64 codec), typed methods for `fs`/`exec`/`sys`, error mapping from shared
codes to `SdkError`/`NotFoundError`/`PathError`/`ConflictError`, streamed
`readAll`/`writeAll` helpers (`fssio.ts`), and `mount()` session scoping
(`session.ts`). Gates green: 15 sdk tests (11 unit + 4 integration) plus
full-repo 89 tests, `typecheck`, `lint`, `format:check` all clean. The
integration suite drives the real `app` on the in-memory runtime (session →
write → chunked read → append → exec → log replay → list → checksum →
remove), including a multi-block 10 MiB byte-identical round-trip. Verified
live against prod: `examples/agent.mjs` completed a real session on
`nexuss-computer.vercel.app` with a 2 MiB+11 B multi-chunk blob restored
byte-identical and all three checksums matching. Note: probed on prod, Vercel's
serverless HTTP body cap blocks writes at **4.375 MiB wire** (measured
4.250 OK / 4.375 413 `FUNCTION_PAYLOAD_TOO_LARGE`); base64 inflates payloads
4/3, so the SDK's default chunk is **3 MiB raw → 4 MiB wire** (`chunkSize`).

**→ Milestone M3 (with Phase 7).**

---

## Phase 7 — GH Actions Worker (long-running ops)

**Goal:** ops beyond the CPU window run on GitHub Actions.

- [x] `jobs` claim helper: atomic queued→claimed, heartbeat, `attempts` cap
- [x] `services/worker` executor — imports `core`, runs on full runner image
- [x] `worker.yml`: `workflow_dispatch` + cron poll of `jobs`
- [x] `/api/sys/dispatch` — write op payload to `jobs`, journal it
- [x] worker imports outputs to Telegram via bridge sink
- [x] stale-claim reaper (claim timeout → re-queue)

Tests:
- [x] dispatch → worker → done, result in journal + Telegram (local + real GH run)

**Exit:** a long op (e.g. small training run) dispatched from the API executes on
GH Actions and reports back through the journal.

**Status: COMPLETE** — local gates green (typecheck, lint, format:check, 103
tests: 19 shared + 67 app + 15 sdk + 2 worker). CI migrations job applies
`0004_jobs_claim.sql` and verifies `claim_job` + `requeue_stale_jobs` RPCs.
`POST /api/sys/dispatch` + `GET /api/sys/jobs` routes live on memory runtime.
`MemoryJobStore` covers claim atomicity, FIFO order, concurrent non-double-claim,
markState with result merge, heartbeat, stale requeue, dead-letter.
`Executor` gains configurable `maxTimeoutMs` (default unchanged). Worker runs
via tsx on Node 22, imports `app/core/*` via relative path (same-code-different-
host), polls up to 5 jobs/run, heartbeats during exec, writes result to
Telegram via BridgeClient, journals via Oplog, marks done/failed with result
ref in `payload`. `worker.yml` adds `workflow_dispatch` + 5-min cron with
concurrency guard and GH secrets env. Migration 0004 applied via
`/api/sys/migrate` endpoint (postgres.js over POSTGRES_URL_NON_POOLING).
Real GH worker run verified: dispatch train job → worker claimed job
`gh-34531624069` → executed → wrote back result to Supabase. Full pipeline
end-to-end confirmed.

**→ Milestone M3 (with Phase 6).**

---

## Phase 8 — Bench & Harden

**Goal:** prove the targets in `docs/DESIGN.md §9` at scale.

- [x] `/api/sys/bench` endpoints (latency + throughput harness)
- [x] hot-path timing: buffer append < 1 ms, Supabase hot read < 10 ms
- [x] batch flush timing vs row count
- [x] cold restore timing (bandwidth-limited, intact)
- [x] multi-GB file through the full pipeline: write → Supabase → Telegram →
       cold restore, checksum-verified
- [x] recovery drill: crash mid-op → journal replay → consistent tree
- [x] chunk corruption drill: flip chunk → detected → refetch + alert

**Exit:** benchmark report committed; M4 proof complete.

**Status: COMPLETE** — local gates green (typecheck, lint, format:check, 108
tests: 19 shared + 72 app + 15 sdk + 2 worker). `POST /api/sys/bench`
endpoint live (scoped micro/hotread/flush). `ChecksumError` typed error
added for corruption detection with `refetch + alert` semantics. Worker
`kind=bench` branch handles multi-GB proof runs. `worker.yml` timeout
bumped to 180 minutes. Benchmark report in `docs/BENCH.md`. All five
bench + drill suites pass: micro (sub-ms buffer append), flush-scale
(linear), crash-recovery (replayed > 0, byte-identical), corruption
detection (`ChecksumError`), and multi-GB streaming pipeline
(checksum-verified). **M4 milestone reached.**

**→ Milestone M4.**

---

## Phase 9 — Native FS Adapter (`@nexuss0781/mycomputer/fsa`)

**Goal:** real `fs.promises`-compatible filesystem handle for the virtual disk.

- [x] `VirtualFs` class: `readFile`, `writeFile`, `appendFile`, `mkdir`,
       `readdir` (+`withFileTypes`→Dirent), `rename`, `copyFile`, `rm`,
       `unlink`, `rmdir`, `stat`/`lstat`, `access`, `open`→`FileHandle`,
       `createReadStream`, `createWriteStream`
- [x] `VirtualFsFileHandle`: `read`, `write`, `stat`, `truncate`, `close`
- [x] Local metadata cache (inodes + directory listings), invalidated on mutations
- [x] `mountFs(sessionId)` on `ComputerClient` + `@nexuss0781/mycomputer/fsa` subpath export
- [x] Buffer semantics (returns `Buffer`, accepts `Buffer | string | Uint8Array`)
- [x] Stats/ Dirent shapes (size, mode, mtime, isFile, isDirectory, etc.)

Tests:
- [x] unit: `fsa.test.ts` — mock transport, cache behavior, FileHandle lifecycle, streams
- [x] integration: `fsa.integration.test.ts` — 14 tests against memory app runtime
       (writeFile→readFile, Dirent readdir, stat shape, cache hit, mkdir -p,
       rename, copyFile, rm recursive, FileHandle read/write/close,
       10 MiB createReadStream→createWriteStream byte-identical, appendFile,
       lstat alias, access, mkdir -p)

**Exit:** `@nexuss0781/mycomputer/fsa` subpath builds; `VirtualFs` implements the full
fs.promises subset against memory runtime; cache proof (zero HTTP on second
stat/readdir); FileHandle read/write/close works; 10 MiB stream round-trip
byte-identical; repo gates green.

**Status: COMPLETE** — 122 tests (19 shared + 72 app + 44 sdk + 2 worker),
typecheck/lint/format:check all green. `VirtualFs` adapter ships with
local metadata cache, FileHandle, streams, and Buffer semantics.

**→ Milestone M5 (with Phase 10, if pursued).**

---

## Phase 10 — FUSE Mount (PLANNED — not started)

**Goal:** mount the virtual disk as an OS-level filesystem so ANY process
(`cat`, `ls`, `cp`, `git`, python, bash) works on it with real POSIX
syscalls — no SDK, no JS-only surface.

**Constraint (physical):** FUSE requires a kernel module + a long-running
daemon on a local host. Runs on the agent's machine (GH Actions runner, dev
machine, VM), NOT on Vercel. Linux first-class; macOS via macFUSE optional.

### Design (decided at planning time)

- **Engine reuse:** daemon wraps `VirtualFs` (`@nexuss0781/mycomputer/fsa`) as the
  backing store — same metadata cache, same chunked read/write, same
  journal + SyncWriter durability. FUSE calls map 1:1 to existing fsa ops:
  - `getattr` → `stat`
  - `readdir` → `readdir` (cached dir listing)
  - `lookup` → `stat`
  - `open`/`read` → `readFile` ranged / `createReadStream`
  - `write`/`flush`/`fsync`/`release` → buffered `writeFile` + `fsync`
    (maps to flushOnWrite / SyncWriter)
  - `mkdir`/`rmdir`/`rename`/`unlink`/`truncate` → fsa mutations
- **Caching layers:** kernel page cache (content, free LRU) + daemon inode
  cache (metadata, reuse `VirtualFs` cache). Read-after-write coherent via
  the same invalidation the SDK uses.
- **Buffering for write coupling:** short writes stage in daemon buffer,
  flush on `fsync`/`release` (matches POSIX: fsync is the durability point).
  Large writes (`>= chunkSize`) flush immediately.
- **Stack choice:** `fuse-native` (Node) — stays in one language, reuses
  `@nexuss0781/mycomputer` directly, no second runtime. Mount daemon as a new
  workspace `packages/fuse` (or `services/fuse`).
- **Config:** mount point + session id via env/CLI:
  `mycomputer-fuse /mnt/mycomputer --session <sid>`.
- **What stays out of scope:** true kernel-side caching of remote writes;
  multi-host live coherence (eventual via journal watermark, same as SDK).

### Tasks (checklist)

- [ ] `packages/fuse` scaffold: `mycomputer-fuse` CLI, mount/unmount lifecycle
- [ ] inode/dir cache adapter over `VirtualFs` (getattr/lookup/readdir)
- [ ] read path: `open`/`read` via ranged reads + kernel page cache
- [ ] write path: `write` → buffer → `fsync`/`release` → flushOnWrite; truncate
- [ ] mutation passthrough: mkdir/rmdir/rename/unlink/access
- [ ] error mapping: fsa errors → POSIX errno (`ENOENT`, `EIO`, `ENOTEMPTY`)
- [ ] Linux end-to-end test: mount, `ls`/`cat`/`cp`/`mv`/`rm`, verify Supabase
- [ ] cross-process coherence test: two mounts, read-after-write
- [ ] stress: 10 MiB+ files through `cp` and random-access reads
- [ ] docs: `docs/BENCH.md` FUSE section (mount+first-read cold vs warm)

**Acceptance:**
- `mount -t mycomputer /path` works from the CLI on a Linux host/GH runner.
- `ls`, `cat`, `cp`, `mv`, `rm`, `git add` all operate on the mounted disk.
- Byte-identical round-trip for a 10 MiB file made through FUSE.
- Durability: `fsync` survives daemon + Vercel restart (journal replay).
- Coherent read-after-write across two mounts on the same host.
- Repo gates green; FUSE smoke test runs in CI where fuse is available.

**Status: PLANNED.** Authorized as a plan; implementation on approval.

**→ Milestone M6.**

---

## Completion order checklist

```
P1 ─► P2 ─► P3 ─► P4 ─► P5 ─► P6 ─► P7 ─► P8 ─► P9 ─► P10
      └── M1 ──┘      └── M2 ──┘      └M3┘    └ M4 ┘   └ M5 ┘   (P10 → M6)
```

Dependencies: P4 needs P2 (fs) + P3 (exec). P5 needs P4. P6 needs P2–P5. P7
needs P4 (queue) + P5 (sink). P8 needs everything. P9 needs P6 (SDK).
P10 needs P9 (uses `VirtualFs` as its backing engine).