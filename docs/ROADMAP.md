# My-Computer — Roadmap

Current goal: **Computer operation for Agentic AI**, scaling to long-running
operations for AI training on GitHub Actions.

## Where we are

**Phase 0 complete** — spec written (`docs/Project.md`), system designed
(`docs/DESIGN.md`). Green light to build. External dependencies identified:

- Vercel project + env (Supabase keys, bridge URL/token)
- Supabase instance + migrations
- Hosted bot bridge (provided externally — we consume the contract)
- Telegram private channel as storage vault
- GitHub repo with Actions enabled

## Roadmap

| Phase | Name                                  | Delivers                                            |
| ----- | ------------------------------------- | --------------------------------------------------- |
| 0     | Spec & Design                         | Docs (done)                                         |
| 1     | Scaffold                              | Monorepo, TS, CI, DB migrations, dev env             |
| 2     | FS Engine                             | File ops + op journal on the virtual disc            |
| 3     | Terminal                              | Command execution with captured output               |
| 4     | Quick Persistence                     | Sub-ms batch write path to Supabase                  |
| 5     | Telegram Sink                         | Chunked upload/manifest, cold reads via bridge       |
| 6     | SDK                                   | `@mycomputer/sdk` for agents                         |
| 7     | GH Actions Worker                     | Long-running ops / AI training dispatch              |
| 8     | Bench & Harden                        | Benchmarks, recovery tests, large-file (multi-GB) proof |

## Milestones

- **M1 (Phases 1–3):** agent can operate a virtual filesystem and a terminal,
  everything journaled. Vertical slice: `write → read → list → exec`.
- **M2 (Phases 4–5):** durability everywhere. Writes land in Supabase fast;
  content flushed to Telegram forever; cold reads restore any file.
- **M3 (Phases 6–7):** an agent drives the computer via SDK; heavy work auto-
  flows to the GH Actions worker and results come back through the journal.
- **M4 (Phase 8):** proof at scale — multi-GB file through the full pipeline,
  published benchmarks vs targets in `docs/DESIGN.md §9`.

## Definition of done

- Every op survives a function crash (journal replay).
- Hot read < 10 ms, batch flush ~1–10 ms, sub-ms local buffer path.
- A file larger than Telegram's per-message ceiling stores and restores intact.
- An op beyond the Vercel duration window runs to completion on GH Actions and
  its result lands in the journal + Telegram.

## Out of scope (external)

- Running the Telegram bot server — consumed via bridge contract only.