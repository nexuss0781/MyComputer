# My-Computer

Computer operation for Agentic AI. A virtual machine where compute and storage are fully decoupled, engineered to scale from short agent operations up to long-running AI training workloads.

## Thesis

One virtual machine where **compute** and **storage** are decoupled:

- **Vercel** is the CPU.
- **Supabase** is the hot RAM (fastest persistence).
- **Telegram** is the cold disk (lifetime persistence, unlimited).
- **Bot** is the delivery layer; the **Telegram channel** is storage.
- **GitHub Actions** is the scale-up path for long-running operations (AI training).

Everything an agent does is an **operation** that gets journaled, then persisted twice: fast (Supabase, ~ms) and forever (Telegram channel, via the bot bridge).

## Goals

- Computer operation for Agentic AI.
- Scale to long-running operations for AI training using GitHub Actions.
- No artificial limits: file size, storage size, operation duration.

## Core Features

- **Persistent disc** — a virtual file tree, not an ephemeral sandbox.
- **Sub-millisecond latency** — in-memory/batch path for the hot loop.
- **Quick persistence** — batched multi-row writes to Supabase.
- **Full persistence** — chunked, immutable upload to a Telegram channel.
- **Full file operations** — create, read, write, append, list, move, copy, delete, mkdir.
- **Terminal execution** — run commands, capture stdout/stderr/exit code.
- **No 2GB limit** — the hosted bot server chunks on write and reassembles on read, so per-file size and total storage are effectively unlimited.

## Stack

### Monorepo

| Choice          | Rationale                                        |
| --------------- | ------------------------------------------------ |
| pnpm workspaces | Fast, strict, native workspace linking           |
| Turborepo       | Parallel tasks + build cache                     |
| TypeScript 5.x  | Strict typing across every layer                 |
| Biome           | One tool for lint + format, near-zero config     |
| Vitest          | Unit tests for core engines, native TS           |

### CPU — Vercel Functions

| Choice                 | Rationale                                                        |
| ---------------------- | --------------------------------------------------------------- |
| Hono 4                 | Minimal router, first-class on Vercel, RPC-able client           |
| Node runtime (not Edge)| Edge has no child_process/spawn; we need real exec            |
| zod + @hono/zod-validator | Typed I/O on every operation endpoint                         |
| /tmp as scratch        | Writable sandbox for in-op work; the disc is Supabase + Telegram |
| vercel.json maxDuration | Cap for inline short ops; past the window → dispatch_long_run   |

### Fast persistence — Supabase

| Choice                          | Rationale                                            |
| ------------------------------- | ---------------------------------------------------- |
| @supabase/supabase-js          | PostgREST, typed, single surface                     |
| Multi-row batched inserts       | One call = many blocks/inodes rows (the write path) |
| supabase.rpc() for operations   | Append-only journal, crash-safe, replayable          |
| Postgres queue (jobs table)     | Pickup point for GitHub Actions workers              |
| Service role only, RLS off      | Server-side writes; bot reads via API key            |

No ORM. The database is a persistence layer, not an app.

### Lifetime persistence — Telegram (bridge client only)

The bot server is hosted externally. We build only the client in `app`:

| Choice                    | Rationale                                                 |
| ------------------------- | --------------------------------------------------------- |
| telegram-bridge client    | Plain fetch calls to the bot's HTTP API (upload/download) |
| Contract-first            | shared/ protocol spec: endpoints, auth, chunk schema     |
| Chunk + manifest scheme   | path → [tg msg ids]; unlimited size, instant enumeration  |

Required from the bot side at build time: bridge base URL + auth handshake.

### Long-run — GitHub Actions

| Choice                          | Rationale                                        |
| ------------------------------- | ------------------------------------------------ |
| worker.yml workflow_dispatch    | Pulls jobs, executes, writes result via bridge    |
| Same core module                | Executor is shared; only the host changes         |
| Node 22 image                   | Parity with Vercel runtime                        |

### SDK + shared

| Choice              | Rationale                                                |
| ------------------- | -------------------------------------------------------- |
| shared/             | Zod schemas + types + bridge contract — single source of truth |
| sdk/ @nexuss0781/mycomputer | Agents drive the computer: fs.write, terminal.run, sys.bench |

### Dev & verification

| Choice         | Rationale                              |
| -------------- | -------------------------------------- |
| @vercel/cli    | Local dev on the exact runtime         |
| Integration suite | Ops → Supabase batch → bot bridge, with fixtures |
| Bench harness    | Hot-path, batch flush, and cold restore timing |

## Architecture

### Layer map

| Layer       | Role                                                             | Tech                         |
| ----------- | ---------------------------------------------------------------- | ---------------------------- |
| CPU / API   | File ops + terminal execution, exposed as REST                   | Vercel Functions (Hono + Node) |
| Hot RAM     | Fastest persistence, read hot-path, job queue                    | Supabase Postgres            |
| Cold disk   | Lifetime persistence, unlimited, immutable                       | Telegram private channel + bot bridge |
| Long-run    | Ops exceeding the CPU window, dispatched to workers              | GitHub Actions worker        |

### Monorepo layout

```
My-Computer/
  app/                  → Vercel Functions (the CPU)
    src/routes/         → ops/*, exec/*, sys/*
    src/core/           → fs-engine, executor, oplog, session
    src/sync/           → supabase-writer (batch buffer), telegram-bridge sink
  services/worker/      → long-running op executor (used by GH Actions)
  db/
    migrations/         → schema
  .github/workflows/worker.yml
  shared/               → types + wire protocol between layers
  sdk/                  → @nexuss0781/mycomputer for agent clients
```

### Data model (Supabase)

- `sessions` — one per agent/computer instance
- `inodes` — file tree (path, mode, size, owner, mime, checksum)
- `blocks` — content chunks (content_id, seq, size, tg_msg refs)
- `operations` — append-only journal: {op_id, session, op_type, input, result, status, ts}
- `executions` — terminal runs: {exec_id, cmd, cwd, stdout, stderr, exit, duration}
- `jobs` — queued long-running work for GH Actions pickup

## Operation Pipeline (single write path)

1. **Execute** — CPU handler runs the file op or terminal, captures the result in memory.
2. **Journal** — every op is appended to `operations` (crash-safe, replayable).
3. **Quick persist** — the sync writer drains a buffer in batches (multi-row upserts) → Supabase. This is the sub-ms hot path.
4. **Full persist** — after Supabase ack, the async Telegram sink uploads content as chunks (`blocks` → messages), then writes a manifest mapping `path → [msg ids]`. The channel is the immutable disk; `tg_msg` refs in Supabase give instant cold-read addressing.

**Read path:** hot → Supabase (`inodes`/`blocks`); cold → bridge fetches chunk messages from the channel and reassembles.

## Design Decisions That Absorb Physical Constraints

- **CPU window** — Vercel functions cap execution duration. Short ops run inline (the 99% case); anything past the window is `dispatch_long_run` → GH Actions worker pulls from `jobs`, runs, uploads the result to the bridge, reports back. No limit on what you can compute — only on where the long compute stays.
- **Latency floor** — network RTT is physical (~tens of ms). The design delivers: sub-ms for the local/buffered path, single-digit-ms hot reads from Supabase, and unlimited cold reads from Telegram. Limits are on size and time, and benchmarks report real ms numbers.
- **Telegram 2GB/file** — the bot splits anything over the per-message ceiling into chunks with a manifest; a multi-TB dataset is just many messages. Enumeration is instant via the manifest map.
- **No overload on Vercel** — Vercel does compute only; bytes flow straight from memory → Supabase → bridge, never landing on the function beyond the op itself.

## Milestones

1. **Scaffold** — monorepo, shared types, Supabase migrations, env/secret setup.
2. **FS engine** (`app`) — write/read/append/list/move/copy/delete/mkdir + op journal.
3. **Terminal** (`app`) — exec with captured stdout/stderr, streaming to `executions`.
4. **Quick persist** — batch sync writer to Supabase (the sub-ms hot path).
5. **Telegram sink** — chunked upload, manifest, download/reassemble via bridge.
6. **SDK** — `@nexuss0781/mycomputer` so agents can drive the computer.
7. **GH Actions worker** — `jobs` → long-running training/ops → write-back via bridge.
8. **Benchmarks** — hot-path µs/ms numbers, cold-path restore timings, large-file (multi-GB) full-pipeline test.

## External Dependencies

- Vercel project + env vars (Supabase keys, bridge URL, bridge auth).
- Supabase project with migrations applied.
- Hosted bot server exposing the telegram-bridge HTTP contract.
- Telegram private channel as the lifetime storage vault.
- GitHub repo with Actions enabled for the worker workflow.