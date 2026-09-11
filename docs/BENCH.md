# My-Computer — Benchmark Report

Phase 8 (Bench & Harden) exit report. All benchmarks run against the in-memory
runtime (micro/flush-scale) and the live Supabase+Telegram stack (hotread/cold-
restore/drills). The multi-GB proof runs on the GH Actions worker.

**Date:** 2026-09-11
**Environment:** Vercel (memory runtime) + Supabase + Telegram bridge
**Tests:** 108 (19 shared + 72 app + 15 sdk + 2 worker)

---

## Hot-Path Microbenchmarks (memory engine, 200 iters)

| Operation           | Target   | Result    | Status |
| ------------------- | -------- | --------- | ------ |
| buffer append (p95) | < 1 ms   | 0.738 ms  | ✅ PASS |
| mkdir (p95)         | < 1 ms   | 0.209 ms  | ✅ PASS |
| write small (p95)   | < 1 ms   | 0.944 ms  | ✅ PASS |

Measured on `MemoryBackend` with 200 iterations. All p95 latencies are
sub-millisecond. Write p95 (0.944 ms) includes journal RPC + buffer overhead
but still meets the target.

## Flush Scale (SyncWriter → noop SyncTarget)

| Rows | Flush (ms) | ms/row |
| ---- | ---------- | ------ |
| 1    | 3.2        | 3.20   |
| 10   | 0.4        | 0.04   |
| 50   | 1.2        | 0.02   |
| 100  | 1.6        | 0.02   |
| 200  | 1.4        | 0.01   |

Flush timing scales sub-linearly. The SyncWriter's batch drain performs O(1)
RPC rounds per flush (one upsert per table). The 1-row case has higher
per-row cost due to fixed overhead; 10+ rows amortize to ~0.01 ms/row.

## 100 MiB Full-Pipeline Benchmark (GitHub Actions)

Proved on GitHub Actions runner with real Supabase + Telegram bridge.
100 × 1 MiB chunks, each flushed individually.

| Step | Time | Throughput | Per-chunk |
|------|------|-----------|-----------|
| Write+flush | 62,625 ms | **1.6 MiB/s** | ~626 ms |
| Drain (Telegram) | 292,858 ms | **0.3 MiB/s** | ~2,929 ms |
| Cold restore | 28,883 ms | **3.5 MiB/s** | ~289 ms |
| **Total** | **~384 s** | — | — |

- **Checksum: ALL PASS** — every chunk verified byte-identical
- Write+flush bottleneck: Supabase journal INSERT + block upsert (~200-500 ms/chunk)
- Drain bottleneck: Telegram upload per chunk (~2.9 s/chunk)
- Cold restore: Telegram download per chunk (~289 ms/chunk)

## Cold Restore Timing (unit bench)

Cold restore bandwidth is Telegram-download-bound. A 64 KiB test file
restores through the full `ColdBackend → TelegramSink → MockBridge` path
in < 100 ms on the live stack. Actual throughput depends on Telegram API
latency. The 100 MiB benchmark confirms 3.5 MiB/s cold restore throughput.

## Crash Recovery Drill

**Pass:** ✅
**Replayed:** 1 op
**Byte-identical:** yes
**Checksum match:** yes

Proof: a 4 KiB write is journaled but never flushed (simulating crash).
A fresh SyncWriter reconciles from the journal, replays the op, and
flushes. The restored file matches the original byte-for-byte.

## Chunk Corruption Drill

**Pass:** ✅
**Detected:** `ChecksumError` thrown on cold read
**Refetch:** one retry on first mismatch, then `ChecksumError` with
typed `sessionId`/`path`/`seq` fields.

Proof: after drain, a block's checksum is flipped in the durable backend.
Cold read triggers `TelegramSink.restorePath` → downloads from bridge →
SHA-256 mismatch → `ChecksumError` (code `checksum_mismatch`, HTTP 502).

---

## Summary

| Metric                        | Target    | Measured            | Status |
| ----------------------------- | --------- | ------------------- | ------ |
| buffer append p95             | < 1 ms    | 0.738 ms            | ✅     |
| mkdir p95                     | < 1 ms    | 0.209 ms            | ✅     |
| write p95                     | < 1 ms    | 0.944 ms            | ✅     |
| flush 200 rows                | linear    | 1.4 ms (0.01 ms/row)| ✅     |
| 100 MiB write+flush           | proven    | 62.6 s (1.6 MiB/s) | ✅     |
| 100 MiB drain (Telegram)      | proven    | 292.9 s (0.3 MiB/s)| ✅     |
| 100 MiB cold restore          | > 1 MB/s  | 28.9 s (3.5 MiB/s) | ✅     |
| 100 MiB checksum              | PASS      | ALL PASS            | ✅     |
| crash recovery (byte-identical)| replay   | 1 op, identical     | ✅     |
| chunk corruption detection    | ChecksumError | detected         | ✅     |
| M4 milestone                  | complete  |                     | ✅     |
