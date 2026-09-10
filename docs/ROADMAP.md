# My-Computer — Roadmap

Current goal: **Computer operation for Agentic AI**, scaling to long-running
operations for AI training on GitHub Actions.

## Where we are

**Phases 1–6 complete** — docs authored (`docs/Project.md`, `docs/DESIGN.md`),
CI green on github.com/nexuss0781/MyComputer (public), Supabase schema applied
+ verified (self-healing migrations run from Vercel), prod selftest `26/26`
live (18 base + 4 persistence + 4 cold, coldVerified true, batch flush ~92 ms).
Phase 2/3/4/5 exit reports in `docs/TODO.md`. Phase 6 (SDK) exit report
(`eaef9cb`, `7d637b2`, `84913e8`) in `docs/PHASES.md`.

**Current: Phase 7 — GH Actions Worker.** Phase 7 code complete, real GH
worker run verified (end-to-end: dispatch → claim → execute → write-back).

## Roadmap

| Phase | Name                                  | Delivers                                            |
| ----- | ------------------------------------- | --------------------------------------------------- |
| 0     | Spec & Design                         | Docs (done)                                         |
| 1     | Scaffold                              | Monorepo, TS, CI, DB migrations, dev env             |
| 2     | FS Engine                             | File ops + op journal on the virtual disc            |
| 3     | Agent Tool Surface                    | Command execution, captured output, tool bridge      |
| 4     | Quick Persistence                     | Sub-ms batch write path to Supabase                  |
| 5     | Telegram Sink                         | Chunked upload/manifest, cold reads via bridge       |
| 6     | SDK                                   | `@mycomputer/sdk` for agents                         |
| 7     | GH Actions Worker                     | Long-running ops / AI training dispatch              |
| 8     | Bench & Harden                        | Benchmarks, recovery tests, large-file (multi-GB) proof |

## Milestones

- **M1 (Phases 1–3):** agent can operate a virtual filesystem and a terminal,
  everything journaled. Vertical slice: `write → read → list → exec`.
  Phase 3 complete: prod selftest `18/18`, `exec/run` + `exec/log` live, tools
  bridge runs commands into the same persisting executor.
- **M2 (Phases 4–5):** durability everywhere. Writes land in Supabase fast
  (Phase 4 complete: prod selftest `22/22`, flush ~106 ms/batch, idempotent
  reconcile); content flushed to Telegram forever (Phase 5 complete: prod
  selftest `26/26`, cold `4/4` byte-identical restore, connected to live
  bridge `telegram-bot-api-1.onrender.com`); cold reads restore any file.
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