/**
 * 100 MB end-to-end benchmark:
 * write → Supabase flush → Telegram drain → prune → cold restore
 */
import { createClient } from '@supabase/supabase-js';
import { BatchBackend } from './core/batch-backend.js';
import { sha256Hex } from './core/chunker.js';
import { ColdBackend } from './core/cold-backend.js';
import { FsEngine } from './core/fs-engine.js';
import { SupabaseJournalStore } from './core/journal-supabase.js';
import { Oplog } from './core/oplog.js';
import { SupabaseBackend } from './core/supabase-backend.js';
import { SupabaseSyncStateStore, SupabaseSyncTarget } from './core/sync-supabase.js';
import { TelegramSink } from './core/sync-telegram.js';
import { SyncWriter } from './core/sync.js';
import { BridgeClient } from '../shared/src/bridge-client.js';
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

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const bridgeUrl = process.env.BRIDGE_URL!;
const bridgeToken = process.env.BRIDGE_TOKEN!;
const bridgeChannelId = process.env.BRIDGE_CHANNEL_ID!;

const db = createClient(url, key);
const syncState = new SupabaseSyncStateStore(db);
const journal = new Oplog(new SupabaseJournalStore(db));
const target = new SupabaseSyncTarget(db, syncState);
const writer = new SyncWriter({ target, state: syncState });
const durableBackend = new SupabaseBackend(db);
const bridge = new BridgeClient({ baseUrl: bridgeUrl, token: bridgeToken, channelId: bridgeChannelId });
const sink = new TelegramSink(bridge, target);
const engine = new FsEngine(
  new BatchBackend(new ColdBackend(durableBackend, sink), writer),
  journal,
);
const sessions = new SupabaseSessionStore(db);

const SIZE_MB = 100;
const TOTAL_BYTES = SIZE_MB * 1024 * 1024;
const CHUNK_MB = 1;
const CHUNK_BYTES = CHUNK_MB * 1024 * 1024;
const TOTAL_CHUNKS = Math.ceil(TOTAL_BYTES / CHUNK_BYTES);

console.log(`\n=== ${SIZE_MB} MB END-TO-END BENCHMARK ===`);
console.log(`Size: ${SIZE_MB} MiB (${TOTAL_BYTES} bytes)`);
console.log(`Blocks: ${TOTAL_CHUNKS} × ${CHUNK_MB} MiB\n`);

// 1. Create session
const t0 = Date.now();
const session = await sessions.create({ name: `bench-100mb-${Date.now()}` });
const sid = session.id;
console.log(`Session: ${sid} (${Date.now() - t0} ms)`);

// 2. Write 100 MB — flush every 4 chunks to avoid single-RPC payload blowup
const t1 = Date.now();
const FLUSH_EVERY = 1;
let totalFlushed = 0;
let flushCount = 0;
for (let i = 0; i < TOTAL_CHUNKS; i++) {
  const size = Math.min(CHUNK_BYTES, TOTAL_BYTES - i * CHUNK_BYTES);
  const chunk = deterministicBytes(i * 31, size);
  if (i === 0) await engine.write(sid, '/bench.bin', chunk);
  else await engine.append(sid, '/bench.bin', chunk);

  if ((i + 1) % FLUSH_EVERY === 0 || i === TOTAL_CHUNKS - 1) {
    const tF = Date.now();
    const s = await writer.flush();
    totalFlushed += s.flushed;
    flushCount += 1;
    process.stdout.write(`\r  Write+flush: ${i + 1}/${TOTAL_CHUNKS} (${Date.now() - tF} ms flush)`);
  }
}
const writeMs = Date.now() - t1;
console.log(`\n  Write+flush: ${writeMs} ms (${(SIZE_MB / (writeMs / 1000)).toFixed(1)} MiB/s, ${flushCount} flushes, ${totalFlushed} items)`);

// 4. Drain to Telegram
const t3 = Date.now();
const drain = await sink.drain(sid);
console.log(`  Drain: ${Date.now() - t3} ms (${drain.uploaded} docs)`);

// 5. Prune
const t4 = Date.now();
await db.from('blocks').update({ data: null }).eq('session_id', sid).eq('path', '/bench.bin');
console.log(`  Prune: ${Date.now() - t4} ms`);

// 6. Cold restore from Telegram
const coldState = new SupabaseSyncStateStore(db);
const coldTarget = new SupabaseSyncTarget(db, coldState);
const coldWriter = new SyncWriter({ target: coldTarget, state: coldState });
const coldBridge = new BridgeClient({ baseUrl: bridgeUrl, token: bridgeToken, channelId: bridgeChannelId });
const coldSink = new TelegramSink(coldBridge, coldTarget);
const coldEngine = new FsEngine(
  new BatchBackend(new ColdBackend(durableBackend, coldSink), coldWriter),
  new Oplog(new SupabaseJournalStore(db)),
);

const t5 = Date.now();
const restored = await coldEngine.read(sid, '/bench.bin');
const coldMs = Date.now() - t5;
const restoredBytes = Buffer.from(restored.content, 'base64').byteLength;

// Checksum
const full = new Uint8Array(TOTAL_BYTES);
for (let i = 0; i < TOTAL_CHUNKS; i++) {
  const chunk = deterministicBytes(i * 31, Math.min(CHUNK_BYTES, TOTAL_BYTES - i * CHUNK_BYTES));
  full.set(chunk, i * CHUNK_BYTES);
}
const expected = sha256Hex(full);
const ok = restored.checksum === expected;

console.log(`  Cold restore: ${coldMs} ms (${(restoredBytes / 1024 / 1024 / (coldMs / 1000)).toFixed(1)} MiB/s)`);
console.log(`  Size: ${(restoredBytes / 1024 / 1024).toFixed(2)} MiB`);
console.log(`  Checksum: ${ok ? 'PASS' : 'FAIL'}`);

await sessions.delete(sid);

const total = Date.now() - t0;
console.log(`\n=== RESULTS ===`);
console.log(`Write+flush:   ${writeMs} ms  (${(SIZE_MB / (writeMs / 1000)).toFixed(1)} MiB/s, ${flushCount} flushes)`);
console.log(`Drain:         ${Date.now() - t3} ms  (${drain.uploaded} docs)`);
console.log(`Cold restore:  ${coldMs} ms  (${(restoredBytes / 1024 / 1024 / (coldMs / 1000)).toFixed(1)} MiB/s)`);
console.log(`Total:         ${total} ms`);
console.log(`Checksum:      ${ok ? 'PASS' : 'FAIL'}`);
