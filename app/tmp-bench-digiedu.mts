/**
 * Real-project filesystem benchmark:
 * Clone a GitHub repo, write all files into the virtual fs,
 * then benchmark edit / rename / delete / list operations.
 */
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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

// ── Setup ──────────────────────────────────────────────────────────
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

// ── Clone repo ─────────────────────────────────────────────────────
const REPO_URL = 'https://github.com/nexuss0781/Digital-Edu';
const CLONE_DIR = '/tmp/Digital-Edu';
execSync(`git clone --depth 1 ${REPO_URL} ${CLONE_DIR}`, { stdio: 'pipe' });

// ── Collect all files ──────────────────────────────────────────────
function walkDir(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git') continue;
      files.push(...walkDir(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

const allFiles = walkDir(CLONE_DIR);
const totalBytes = allFiles.reduce((sum, f) => sum + statSync(f).size, 0);
console.log(`\n=== REAL PROJECT BENCHMARK: Digital-Edu ===`);
console.log(`Files: ${allFiles.length}`);
console.log(`Total size: ${(totalBytes / 1024 / 1024).toFixed(2)} MiB`);

// Filter to text files only (skip binaries)
const textFiles = allFiles.filter((f) => {
  try {
    const buf = readFileSync(f);
    for (let i = 0; i < Math.min(buf.length, 512); i++) {
      if (buf[i] === 0) return false; // binary
    }
    return true;
  } catch {
    return false;
  }
});
console.log(`Text files: ${textFiles.length}`);

// ── Create session ─────────────────────────────────────────────────
const session = await sessions.create({ name: `bench-digiedu-${Date.now()}` });
const sid = session.id;
await engine.sessionInit(sid);
console.log(`Session: ${sid}\n`);

// ── 1. WRITE all files (flush every 50) ───────────────────────────
console.log('--- WRITE ---');
const fileMap = new Map<string, { path: string; content: Buffer; checksum: string }>();
const tWrite = Date.now();
let writeBytes = 0;
let writeFlushes = 0;
for (let i = 0; i < textFiles.length; i++) {
  const absPath = textFiles[i]!;
  const relPath = '/' + relative(CLONE_DIR, absPath);
  const content = readFileSync(absPath);
  const checksum = sha256Hex(content);
  fileMap.set(relPath, { path: relPath, content, checksum });

  await engine.write(sid, relPath, new Uint8Array(content));
  writeBytes += content.byteLength;

  if ((i + 1) % 50 === 0 || i === textFiles.length - 1) {
    await writer.flush();
    writeFlushes += 1;
    process.stdout.write(`\r  ${i + 1}/${textFiles.length} files (${(writeBytes / 1024).toFixed(0)} KiB, ${writeFlushes} flushes)`);
  }
}
const writeMs = Date.now() - tWrite;
console.log(`\n  ${writeMs} ms (${(writeBytes / 1024 / (writeMs / 1000)).toFixed(0)} KiB/s, ${writeFlushes} flushes)`);

// ── 2. LIST (read directory) ──────────────────────────────────────
console.log('--- LIST (100 iterations) ---');
const listPaths = ['/', '/src', '/public'];
const listTimes: number[] = [];
for (let i = 0; i < 100; i++) {
  const p = listPaths[i % listPaths.length]!;
  const t0 = Date.now();
  await engine.list(sid, p);
  listTimes.push(Date.now() - t0);
}
const sortedList = [...listTimes].sort((a, b) => a - b);
console.log(`  p50=${sortedList[49]} ms, p95=${sortedList[94]} ms, min=${sortedList[0]} ms`);

// ── 4. READ (random reads) ────────────────────────────────────────
console.log('--- READ (100 iterations) ---');
const readPaths = [...fileMap.keys()];
const readTimes: number[] = [];
for (let i = 0; i < 100; i++) {
  const p = readPaths[i % readPaths.length]!;
  const t0 = Date.now();
  await engine.read(sid, p);
  readTimes.push(Date.now() - t0);
}
const sortedRead = [...readTimes].sort((a, b) => a - b);
console.log(`  p50=${sortedRead[49]} ms, p95=${sortedRead[94]} ms, min=${sortedRead[0]} ms`);

// ── 5. EDIT (overwrite 20 files) ──────────────────────────────────
console.log('--- EDIT (overwrite 20 files) ---');
const editTargets = readPaths.slice(0, 20);
const editTimes: number[] = [];
for (const p of editTargets) {
  const existing = fileMap.get(p)!;
  const edited = Buffer.concat([existing.content, Buffer.from('\n// edited\n')]);
  const t0 = Date.now();
  await engine.write(sid, p, new Uint8Array(edited));
  editTimes.push(Date.now() - t0);
  fileMap.set(p, { ...existing, content: edited, checksum: sha256Hex(edited) });
}
const sortedEdit = [...editTimes].sort((a, b) => a - b);
console.log(`  p50=${sortedEdit[9]} ms, p95=${sortedEdit[18]} ms, min=${sortedEdit[0]} ms`);

// ── 6. RENAME (10 files) ──────────────────────────────────────────
console.log('--- RENAME (10 files) ---');
const renameTargets = editTargets.slice(0, 10);
const renameTimes: number[] = [];
for (const p of renameTargets) {
  const newPath = p.replace(/(\.\w+)$/, '-renamed$1');
  const t0 = Date.now();
  await engine.move(sid, p, newPath);
  renameTimes.push(Date.now() - t0);
  const entry = fileMap.get(p)!;
  fileMap.delete(p);
  fileMap.set(newPath, { ...entry, path: newPath });
}
const sortedRename = [...renameTimes].sort((a, b) => a - b);
console.log(`  p50=${sortedRename[4]} ms, p95=${sortedRename[8]} ms, min=${sortedRename[0]} ms`);

// ── 7. DELETE (30 files) ──────────────────────────────────────────
console.log('--- DELETE (30 files) ---');
const deleteTargets = [...fileMap.keys()].slice(0, 30);
const deleteTimes: number[] = [];
for (const p of deleteTargets) {
  const t0 = Date.now();
  await engine.delete(sid, p);
  deleteTimes.push(Date.now() - t0);
  fileMap.delete(p);
}
const sortedDelete = [...deleteTimes].sort((a, b) => a - b);
console.log(`  p50=${sortedDelete[14]} ms, p95=${sortedDelete[28]} ms, min=${sortedDelete[0]} ms`);

// ── 8. STAT ───────────────────────────────────────────────────────
console.log('--- STAT (100 iterations) ---');
const statPaths = [...fileMap.keys()];
const statTimes: number[] = [];
for (let i = 0; i < 100; i++) {
  const p = statPaths[i % statPaths.length]!;
  const t0 = Date.now();
  await engine.stat(sid, p);
  statTimes.push(Date.now() - t0);
}
const sortedStat = [...statTimes].sort((a, b) => a - b);
console.log(`  p50=${sortedStat[49]} ms, p95=${sortedStat[94]} ms, min=${sortedStat[0]} ms`);

// ── 9. CHECKSUM (100 iterations) ──────────────────────────────────
console.log('--- CHECKSUM (100 iterations) ---');
const csTimes: number[] = [];
for (let i = 0; i < 100; i++) {
  const p = statPaths[i % statPaths.length]!;
  const t0 = Date.now();
  await engine.checksum(sid, p);
  csTimes.push(Date.now() - t0);
}
const sortedCs = [...csTimes].sort((a, b) => a - b);
console.log(`  p50=${sortedCs[49]} ms, p95=${sortedCs[94]} ms, min=${sortedCs[0]} ms`);

// ── Cleanup ───────────────────────────────────────────────────────
await sessions.remove(sid);

// ── Summary ───────────────────────────────────────────────────────
console.log(`\n=== RESULTS ===`);
console.log(`Project:        Digital-Edu (${textFiles.length} files, ${(totalBytes / 1024).toFixed(0)} KiB)`);
console.log(`Write all:      ${writeMs} ms (${(writeBytes / 1024 / (writeMs / 1000)).toFixed(0)} KiB/s)`);
console.log(`Flush:          ${Date.now() - tFlush} ms`);
console.log(`List:           p50=${sortedList[49]} ms, p95=${sortedList[94]} ms`);
console.log(`Read:           p50=${sortedRead[49]} ms, p95=${sortedRead[94]} ms`);
console.log(`Edit:           p50=${sortedEdit[9]} ms, p95=${sortedEdit[18]} ms`);
console.log(`Rename:         p50=${sortedRename[4]} ms, p95=${sortedRename[8]} ms`);
console.log(`Delete:         p50=${sortedDelete[14]} ms, p95=${sortedDelete[28]} ms`);
console.log(`Stat:           p50=${sortedStat[49]} ms, p95=${sortedStat[94]} ms`);
console.log(`Checksum:       p50=${sortedCs[49]} ms, p95=${sortedCs[94]} ms`);
