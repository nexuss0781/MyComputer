/**
 * Execution command benchmark:
 * - spawn latency (simple command)
 * - output capture + Supabase insert
 * - large output (4 MiB cap)
 * - replay latency (read from Supabase)
 */
import { createClient } from '@supabase/supabase-js';
import { Executor, SupabaseExecStore, BufferedExecStore } from './core/executor.js';
import { SyncWriter, type SyncStateStore } from './core/sync.js';
import { SupabaseSyncTarget, SupabaseSyncStateStore } from './core/sync-supabase.js';

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const db = createClient(url, key);

// --- 1. Simple command latency (10 iterations) ---
console.log('\n=== SIMPLE COMMAND LATENCY ===');
const execStore = new SupabaseExecStore(db);
const executor = new Executor(execStore);
const sid = `bench-exec-${Date.now()}`;

const simpleTimes: number[] = [];
for (let i = 0; i < 10; i++) {
  const t0 = Date.now();
  await executor.run(sid, { command: 'echo hello' });
  simpleTimes.push(Date.now() - t0);
}
const sorted = [...simpleTimes].sort((a, b) => a - b);
const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
console.log(`  10 runs: p50=${p50} ms, p95=${p95} ms, min=${sorted[0]} ms, max=${sorted[sorted.length - 1]} ms`);
console.log(`  times: ${simpleTimes.join(', ')} ms`);

// --- 2. Replay latency (read from Supabase) ---
console.log('\n=== REPLAY LATENCY (read from Supabase) ===');
const execs = await executor.list(sid);
const replayTimes: number[] = [];
for (const exec of execs) {
  const t0 = Date.now();
  await executor.get(sid, exec.execId);
  replayTimes.push(Date.now() - t0);
}
const sortedReplay = [...replayTimes].sort((a, b) => a - b);
const rp50 = sortedReplay[Math.floor(sortedReplay.length * 0.5)]!;
const rp95 = sortedReplay[Math.floor(sortedReplay.length * 0.95)]!;
console.log(`  ${replayTimes.length} reads: p50=${rp50} ms, p95=${rp95} ms`);

// --- 3. Large output (generate 4 MiB) ---
console.log('\n=== LARGE OUTPUT (4 MiB) ===');
const largeOut = await executor.run(sid, {
  command: 'dd if=/dev/urandom bs=1024 count=4096 2>/dev/null | base64 | head -c 4194304',
  timeoutMs: 30_000,
});
console.log(`  stdout length: ${(largeOut.stdout?.length ?? 0).toLocaleString()} bytes`);
console.log(`  execution time: ${largeOut.durationMs} ms`);
console.log(`  truncated: ${largeOut.truncated}`);

// --- 4. Buffered exec (batch flush) ---
console.log('\n=== BUFFERED EXEC (batch flush) ===');
const syncState = new SupabaseSyncStateStore(db);
const target = new SupabaseSyncTarget(db, syncState);
const writer = new SyncWriter({ target, state: syncState });
const bufferedStore = new BufferedExecStore(execStore, writer);
const bufferedExec = new Executor(bufferedStore);

// Run 5 commands, then flush once
const tBuf = Date.now();
for (let i = 0; i < 5; i++) {
  await bufferedExec.run(sid, { command: `echo buffered-${i}` });
}
const bufRunMs = Date.now() - tBuf;

const tFlush = Date.now();
await writer.flush();
const flushMs = Date.now() - tFlush;

console.log(`  5 runs (buffered): ${bufRunMs} ms (${(bufRunMs / 5).toFixed(0)} ms/run)`);
console.log(`  flush: ${flushMs} ms`);

// --- 5. Concurrent commands ---
console.log('\n=== CONCURRENT COMMANDS (5 parallel) ===');
const tConc = Date.now();
const results = await Promise.all(
  Array.from({ length: 5 }, (_, i) =>
    executor.run(sid, { command: `sleep 0.1 && echo concurrent-${i}` }),
  ),
);
const concMs = Date.now() - tConc;
console.log(`  5 parallel (sleep 0.1 each): ${concMs} ms`);
console.log(`  all exit 0: ${results.every((r) => r.exitCode === 0)}`);

// Cleanup
await execStore.removeSessionData(sid);

// --- Summary ---
console.log('\n=== SUMMARY ===');
console.log(`Simple exec (echo):      p50=${p50} ms, p95=${p95} ms`);
console.log(`Replay (read from DB):   p50=${rp50} ms, p95=${rp95} ms`);
console.log(`Large output (4 MiB):    ${largeOut.durationMs} ms`);
console.log(`Buffered batch (5 cmds): ${bufRunMs} ms + ${flushMs} ms flush`);
console.log(`Concurrent (5 parallel): ${concMs} ms`);
