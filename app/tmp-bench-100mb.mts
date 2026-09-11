/**
 * 100 MB end-to-end benchmark:
 * write → Supabase flush → Telegram drain → prune → cold restore
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BRIDGE_URL,
 *           BRIDGE_TOKEN, BRIDGE_CHANNEL_ID env vars.
 */
import { loadEnv } from '../shared/src/index.js';
import { createClient } from '@supabase/supabase-js';
import { BatchBackend } from './core/batch-backend.js';
import { sha256Hex } from './core/chunker.js';
import { ColdBackend } from './core/cold-backend.js';
import { FsEngine } from './core/fs-engine.js';
import { SupabaseJournalStore } from './core/journal-supabase.js';
import { BridgeClient } from '../shared/src/bridge-client.js';
import { Oplog } from './core/oplog.js';
import { SupabaseBackend } from './core/supabase-backend.js';
import { SupabaseSyncStateStore, SupabaseSyncTarget } from './core/sync-supabase.js';
import { TelegramSink } from './core/sync-telegram.js';
import { SyncWriter } from './core/sync.js';
import { SupabaseSessionStore } from './src/session.js';

function deterministicBytes(seed: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let s = seed >>> 0;
  for (let i = 0; i < size; i++) {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return out;
}

const env = loadEnv();
const url = env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SECRET_KEY;
if (!url || !key) { console.error('SUPABASE_URL and service key required'); process.exit(1); }
if (!env.BRIDGE_URL || !env.BRIDGE_TOKEN || !env.BRIDGE_CHANNEL_ID) {
  console.error('BRIDGE_URL, BRIDGE_TOKEN, BRIDGE_CHANNEL_ID required');
  process.exit(1);
}

const db = createClient(url, key);
const syncState = new SupabaseSyncStateStore(db);
const journal = new Oplog(new SupabaseJournalStore(db));
const target = new SupabaseSyncTarget(db, syncState);
const writer = new SyncWriter({ target, state: syncState });
const durableBackend = new SupabaseBackend(db);
const bridge = new BridgeClient({
  baseUrl: env.BRIDGE_URL,
  token: env.BRIDGE_TOKEN,
  channelId: env.BRIDGE_CHANNEL_ID,
});
const sink = new TelegramSink(bridge, target);
const engine = new FsEngine(
  new BatchBackend(new ColdBackend(durableBackend, sink), writer),
  journal,
);
const sessions = new SupabaseSessionStore(db);

const SIZE_MB = 100;
const TOTAL_BYTES = SIZE_MB * 1024 * 1024;
const CHUNK_MB = 8;
const CHUNK_BYTES = CHUNK_MB * 1024 * 1024;

console.log(`\n=== 100 MB END-TO-END BENCHMARK ===`);
console.log(`Size: ${SIZE_MB} MiB (${TOTAL_BYTES} bytes)`);
console.log(`Chunk: ${CHUNK_MB} MiB → ${Math.ceil(TOTAL_BYTES / CHUNK_BYTES)} blocks\n`);

// 1. Create session
const t0 = Date.now();
const session = await sessions.create({ name: `bench-100mb-${Date.now()}` });
const sid = session.id;
console.log(`Session created: ${sid} (${Date.now() - t0} ms)`);

// 2. Write100 MB in 8 MiB chunks
const t1 = Date.now();
const totalChunks = Math.ceil(TOTAL_BYTES / CHUNK_BYTES);

for (let i = 0; i < totalChunks; i++) {
  const chunkSize = Math.min(CHUNK_BYTES, TOTAL_BYTES - i * CHUNK_BYTES);
  const chunk = deterministicBytes(i * 31, chunkSize);

  if (i === 0) {
    await engine.write(sid, '/bench-100mb.bin', chunk);
  } else {
    await engine.append(sid, '/bench-100mb.bin', chunk);
  }

  if ((i + 1) % 5 === 0 || i === totalChunks - 1) {
    process.stdout.write(`\r  Write: ${i + 1}/${totalChunks} chunks (${(i + 1) * CHUNK_MB} MiB)`);
  }
}
const writeMs = Date.now() - t1;
console.log(`\n  Write complete: ${writeMs} ms (${(SIZE_MB / (writeMs / 1000)).toFixed(2)} MiB/s)`);

// 3. Flush to Supabase
const t2 = Date.now();
const stats = await writer.flush();
const flushMs = Date.now() - t2;
console.log(`  Flush to Supabase: ${flushMs} ms (${stats.flushed} items)`);

// 4. Drain to Telegram
const t3 = Date.now();
const drainResult = await sink.drain(sid);
const drainMs = Date.now() - t3;
console.log(`  Drain to Telegram: ${drainMs} ms (${drainResult.uploaded} chunks)`);

// 5. Prune (set data = null in Supabase to force cold restore)
const t4 = Date.now();
const { error: pruneErr } = await db
  .from('blocks')
  .update({ data: null })
  .eq('session_id', sid)
  .eq('path', '/bench-100mb.bin');
if (pruneErr) console.error('  Prune error:', pruneErr.message);
else console.log(`  Prune: ${Date.now() - t4} ms`);

// 6. Cold restore — read back100 MB from Telegram
const coldState = new SupabaseSyncStateStore(db);
const coldTarget = new SupabaseSyncTarget(db, coldState);
const coldWriter = new SyncWriter({ target: coldTarget, state: coldState });
const coldBridge = new BridgeClient({
  baseUrl: env.BRIDGE_URL,
  token: env.BRIDGE_TOKEN,
  channelId: env.BRIDGE_CHANNEL_ID,
});
const coldSink = new TelegramSink(coldBridge, coldTarget);
const coldEngine = new FsEngine(
  new BatchBackend(new ColdBackend(durableBackend, coldSink), coldWriter),
  new Oplog(new SupabaseJournalStore(db)),
);

const t5 = Date.now();
const restored = await coldEngine.read(sid, '/bench-100mb.bin');
const coldMs = Date.now() - t5;
const restoredBytes = Buffer.from(restored.content, 'base64').byteLength;

// Compute expected checksum
const fullContent = new Uint8Array(TOTAL_BYTES);
for (let i = 0; i < totalChunks; i++) {
  const chunk = deterministicBytes(i * 31, Math.min(CHUNK_BYTES, TOTAL_BYTES - i * CHUNK_BYTES));
  fullContent.set(chunk, i * CHUNK_BYTES);
}
const expectedChecksum = sha256Hex(fullContent);
const checksumMatch = restored.checksum === expectedChecksum;

console.log(`  Cold restore: ${coldMs} ms (${(restoredBytes / 1024 / 1024 / (coldMs / 1000)).toFixed(2)} MiB/s)`);
console.log(`  Restored size: ${(restoredBytes / 1024 / 1024).toFixed(2)} MiB`);
console.log(`  Checksum match: ${checksumMatch}`);

// 7. Cleanup
await sessions.delete(sid);

const totalTime = Date.now() - t0;
console.log(`\n=== RESULTS ===`);
console.log(`Write (buffer):    ${writeMs} ms  (${(SIZE_MB / (writeMs / 1000)).toFixed(2)} MiB/s)`);
console.log(`Flush (Supabase):  ${flushMs} ms  (${stats.flushed} items)`);
console.log(`Drain (Telegram):  ${drainMs} ms  (${drainResult.uploaded} docs)`);
console.log(`Cold restore:      ${coldMs} ms  (${(restoredBytes / 1024 / 1024 / (coldMs / 1000)).toFixed(2)} MiB/s)`);
console.log(`Total pipeline:    ${totalTime} ms`);
console.log(`Checksum:          ${checksumMatch ? 'PASS' : 'FAIL'}`);
console.log(`\nDone.`);
