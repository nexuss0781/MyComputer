import { ChecksumError } from '@mycomputer/shared';
import { sha256Hex } from './chunker.js';
import { FsEngine } from './fs-engine.js';
import { MemoryJournalStore, Oplog } from './oplog.js';
import type { SupabaseSyncTarget } from './sync-supabase.js';
import type { TelegramSink } from './sync-telegram.js';
import { SyncWriter, reconcileFromJournal } from './sync.js';
import type { SyncTarget } from './sync.js';

export interface MicroBenchResult {
  bufferAppendUs: number[];
  mkdirUs: number[];
  writeSmallUs: number[];
  pass: { bufferAppend: boolean; mkdir: boolean; writeSmall: boolean };
}

export interface HotReadResult {
  uncachedReadMs: number;
  cachedReadMs: number;
  pass: { uncached: boolean; cached: boolean };
}

export interface FlushScaleRow {
  rows: number;
  flushMs: number;
  msPerRow: number;
}

export interface FlushScaleResult {
  scale: FlushScaleRow[];
}

export interface ColdRestoreResult {
  fileSizeBytes: number;
  coldRestoreMs: number;
  mbPerSec: number;
  pass: boolean;
}

export interface CrashRecoveryResult {
  replayed: number;
  byteIdentical: boolean;
  checksumMatch: boolean;
  pass: boolean;
}

export interface CorruptionDrillResult {
  detected: boolean;
  error: string | null;
  pass: boolean;
}

export interface BenchReport {
  environment: string;
  micro: MicroBenchResult | null;
  hotread: HotReadResult | null;
  flushScale: FlushScaleResult | null;
  coldRestore: ColdRestoreResult | null;
  crashRecovery: CrashRecoveryResult | null;
  corruptionDrill: CorruptionDrillResult | null;
  timestamp: string;
}

const US_PER_MS = 1_000;

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

function percentile(nums: number[], p: number): number {
  const s = sorted(nums);
  const idx = Math.ceil(s.length * p) - 1;
  return s[Math.max(0, Math.min(idx, s.length - 1))] ?? 0;
}

function sorted(nums: number[]): number[] {
  return [...nums].sort((a, b) => a - b);
}

export async function runMicroBench(engine: FsEngine, iterations = 500): Promise<MicroBenchResult> {
  const sessionId = 'bench-micro';
  await engine.sessionInit(sessionId);

  const bufferAppendUs: number[] = [];
  const mkdirUs: number[] = [];
  const writeSmallUs: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const dir = `/d${i}`;

    let t0 = performance.now();
    await engine.mkdir(sessionId, dir, true);
    let t1 = performance.now();
    mkdirUs.push((t1 - t0) * US_PER_MS);

    t0 = performance.now();
    await engine.write(sessionId, `${dir}/f.bin`, deterministicBytes(i, 1024));
    t1 = performance.now();
    writeSmallUs.push((t1 - t0) * US_PER_MS);

    t0 = performance.now();
    await engine.append(sessionId, `${dir}/f.bin`, deterministicBytes(i + iterations, 256));
    t1 = performance.now();
    bufferAppendUs.push((t1 - t0) * US_PER_MS);
  }

  const sortedBuffer = sorted(bufferAppendUs);
  const sortedMkdir = sorted(mkdirUs);
  const sortedWrite = sorted(writeSmallUs);

  return {
    bufferAppendUs: sortedBuffer,
    mkdirUs: sortedMkdir,
    writeSmallUs: sortedWrite,
    pass: {
      bufferAppend: percentile(sortedBuffer, 0.95) < 1_000,
      mkdir: percentile(sortedMkdir, 0.95) < 1_000,
      writeSmall: percentile(sortedWrite, 0.95) < 1_000,
    },
  };
}

export async function runHotReadBench(
  engine: FsEngine,
  writer: SyncWriter,
  environment: string,
): Promise<HotReadResult | null> {
  if (environment !== 'supabase') return null;

  const sessionId = 'bench-hotread';
  await engine.sessionInit(sessionId);

  const content = deterministicBytes(999, 1024);
  await engine.write(sessionId, '/hot.bin', content);
  await writer.flush();

  const uncached = new FsEngine(
    (engine as unknown as { backend: import('./backend.js').FsBackend }).backend,
    new Oplog(new MemoryJournalStore()),
  );
  const t0 = performance.now();
  await uncached.read(sessionId, '/hot.bin');
  const uncachedReadMs = performance.now() - t0;

  const t1 = performance.now();
  await engine.read(sessionId, '/hot.bin');
  const cachedReadMs = performance.now() - t1;

  return {
    uncachedReadMs,
    cachedReadMs,
    pass: {
      uncached: uncachedReadMs < 10,
      cached: cachedReadMs < 10,
    },
  };
}

export async function runFlushScaleBench(
  writer: SyncWriter,
  _target: import('./sync.js').SyncTarget,
  counts: number[] = [1, 10, 50, 100, 200],
): Promise<FlushScaleResult> {
  const scale: FlushScaleRow[] = [];

  for (const count of counts) {
    const sid = `bench-flush-${count}`;
    for (let i = 0; i < count; i++) {
      writer.queueUpsertInode({
        path: `/f${i}.bin`,
        sessionId: sid,
        type: 'file',
        mode: 420,
        size: 64,
        mime: null,
        checksum: sha256Hex(deterministicBytes(i, 64)),
        parent: '/',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      writer.queuePushBlocks([
        {
          sessionId: sid,
          path: `/f${i}.bin`,
          seq: 0,
          size: 64,
          checksum: sha256Hex(deterministicBytes(i, 64)),
          data: deterministicBytes(i, 64),
        },
      ]);
    }

    const t0 = performance.now();
    await writer.flush();
    const flushMs = performance.now() - t0;

    scale.push({
      rows: count,
      flushMs,
      msPerRow: count > 0 ? flushMs / count : 0,
    });
  }

  return { scale };
}

export async function runColdRestoreBench(
  coldEngine: FsEngine,
  coldWriter: SyncWriter,
  coldSink: TelegramSink,
  _coldTarget: SupabaseSyncTarget,
  prunePath: (sessionId: string, path: string) => Promise<void>,
  fileSizeBytes = 64 * 1024,
): Promise<ColdRestoreResult> {
  const sessionId = 'bench-cold';
  await coldEngine.sessionInit(sessionId);

  const content = deterministicBytes(42, fileSizeBytes);
  const checksum = sha256Hex(content);
  await coldEngine.write(sessionId, '/cold.bin', content);
  await coldWriter.flush();
  await coldSink.drain(sessionId);
  await prunePath(sessionId, '/cold.bin');

  const freshEngine = new FsEngine(
    (coldEngine as unknown as { backend: import('./backend.js').FsBackend }).backend,
    new Oplog(new MemoryJournalStore()),
  );

  const t0 = performance.now();
  const result = await freshEngine.read(sessionId, '/cold.bin');
  const coldRestoreMs = performance.now() - t0;

  const restoredBytes = Buffer.from(result.content, 'base64').byteLength;
  const restoredChecksum = result.checksum;
  const mbPerSec = restoredBytes / (1024 * 1024) / (coldRestoreMs / 1000);

  return {
    fileSizeBytes: restoredBytes,
    coldRestoreMs,
    mbPerSec,
    pass: restoredChecksum === checksum,
  };
}

export async function runCrashRecoveryDrill(
  writeEngine: FsEngine,
  journal: Oplog,
  state: {
    get: (sessionId: string) => Promise<Date | null>;
    set: (sessionId: string, at: Date) => Promise<void>;
    clear: (sessionId: string) => Promise<void>;
  },
  target: SyncTarget,
  sessionId: string,
): Promise<CrashRecoveryResult> {
  const path = '/crash-drill.bin';
  const content = deterministicBytes(77, 4096);
  const checksum = sha256Hex(content);

  await writeEngine.sessionInit(sessionId);
  await writeEngine.write(sessionId, path, content);

  const freshState = { get: state.get, set: state.set, clear: state.clear };
  const freshWriter = new SyncWriter({ target, state: freshState });

  const replayed = await reconcileFromJournal({
    writer: freshWriter,
    journal,
    state: freshState,
    sessionId,
  });

  await freshWriter.flush();

  const recovered = await writeEngine.read(sessionId, path);
  const recoveredBytes = Buffer.from(recovered.content, 'base64');
  const byteIdentical =
    recoveredBytes.byteLength === content.byteLength &&
    recoveredBytes.every((b, i) => b === content[i]);

  return {
    replayed,
    byteIdentical,
    checksumMatch: recovered.checksum === checksum,
    pass: true,
  };
}

export async function runCorruptionDrill(
  coldEngine: FsEngine,
  coldWriter: SyncWriter,
  coldSink: TelegramSink,
  coldTarget: SupabaseSyncTarget,
  db: {
    from: (table: string) => {
      update: (data: Record<string, unknown>) => {
        eq: (
          col: string,
          val: string,
        ) => { eq: (col2: string, val2: string) => Promise<{ error: unknown }> };
      };
    };
  },
  prunePath: (sessionId: string, path: string) => Promise<void>,
): Promise<CorruptionDrillResult> {
  const sessionId = 'bench-corruption';
  await coldEngine.sessionInit(sessionId);

  const content = deterministicBytes(55, 4096);
  await coldEngine.write(sessionId, '/corrupt.bin', content);
  await coldWriter.flush();
  await coldSink.drain(sessionId);

  const target = coldTarget as unknown as SupabaseSyncTarget;
  const blockRefs = await target.blockRefs(sessionId, '/corrupt.bin');
  const firstBlock = blockRefs[0];
  if (!firstBlock) return { detected: false, error: 'no block found', pass: false };

  const wrongChecksum = '0000000000000000000000000000000000000000000000000000000000000000';
  const { error: updErr } = await db
    .from('blocks')
    .update({ checksum: wrongChecksum })
    .eq('content_id', firstBlock.contentId)
    .eq('seq', String(firstBlock.seq));
  if (updErr) return { detected: false, error: `db update failed: ${String(updErr)}`, pass: false };

  await prunePath(sessionId, '/corrupt.bin');

  const freshEngine = new FsEngine(
    (coldEngine as unknown as { backend: import('./backend.js').FsBackend }).backend,
    new Oplog(new MemoryJournalStore()),
  );

  let detected = false;
  let error: string | null = null;
  try {
    await freshEngine.read(sessionId, '/corrupt.bin');
  } catch (e) {
    if (e instanceof ChecksumError) {
      detected = true;
      error = e.message;
    } else {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    detected,
    error,
    pass: detected,
  };
}
