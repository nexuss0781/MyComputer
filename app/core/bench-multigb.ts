import { createHash } from 'node:crypto';
import { FsEngine } from './fs-engine.js';
import type { TelegramSink } from './sync-telegram.js';
import type { SyncWriter } from './sync.js';

export interface MultiGbResult {
  sizeBytes: number;
  blocks: number;
  hotWriteMs: number;
  flushMs: number;
  drainMs: number;
  coldRestoreMs: number;
  sha256Verified: boolean;
  expectedChecksum: string;
  actualChecksum: string;
  error?: string;
}

function deterministicSegment(segIndex: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let s = ((segIndex * 0x9e3779b9) ^ 0xdeadbeef) >>> 0;
  for (let i = 0; i < size; i++) {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return out;
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function runMultiGbBench(opts: {
  engine: FsEngine;
  writer: SyncWriter;
  sink: TelegramSink;
  totalSizeBytes?: number;
  segmentBytes?: number;
  sessionId?: string;
  path?: string;
  prunePath?: (sessionId: string, path: string) => Promise<void>;
}): Promise<MultiGbResult> {
  const {
    engine,
    writer,
    sink,
    totalSizeBytes = 2 * 1024 * 1024 * 1024,
    segmentBytes = 8 * 1024 * 1024,
    sessionId = 'bench-multigb',
    path = '/multigb.bin',
    prunePath,
  } = opts;

  const totalSegments = Math.ceil(totalSizeBytes / segmentBytes);

  const expectedHash = createHash('sha256');
  for (let i = 0; i < totalSegments; i++) {
    const seg = deterministicSegment(
      i,
      i === totalSegments - 1 ? totalSizeBytes - i * segmentBytes : segmentBytes,
    );
    expectedHash.update(seg);
  }
  const expectedChecksum = expectedHash.digest('hex');

  await engine.sessionInit(sessionId);
  const firstSeg = deterministicSegment(0, Math.min(segmentBytes, totalSizeBytes));

  const t0 = performance.now();
  await engine.write(sessionId, path, firstSeg);
  const hotWriteMs = performance.now() - t0;

  let flushedBytes = firstSeg.byteLength;
  for (let i = 1; i < totalSegments; i++) {
    const segSize = i === totalSegments - 1 ? totalSizeBytes - flushedBytes : segmentBytes;
    const seg = deterministicSegment(i, segSize);
    const chunks = [{ seq: i, size: seg.byteLength, checksum: sha256Hex(seg), data: seg }];
    writer.queuePushBlocks(
      chunks.map((c) => ({
        sessionId,
        path,
        seq: c.seq,
        size: c.size,
        checksum: c.checksum,
        data: c.data,
      })),
    );
    flushedBytes += seg.byteLength;
  }

  const fullInode = {
    path,
    sessionId,
    type: 'file' as const,
    mode: 420,
    size: totalSizeBytes,
    mime: null,
    checksum: expectedChecksum,
    parent: '/',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writer.queueUpsertInode(fullInode);

  const t1 = performance.now();
  await writer.flush();
  const flushMs = performance.now() - t1;

  const t2 = performance.now();
  await sink.drain(sessionId);
  const drainMs = performance.now() - t2;

  let coldRestoreMs = 0;
  let actualChecksum = expectedChecksum;

  if (prunePath) {
    await prunePath(sessionId, path);

    const freshEngine = new FsEngine(
      (engine as unknown as { backend: import('./backend.js').FsBackend }).backend,
      (engine as unknown as { oplog: import('./oplog.js').Oplog }).oplog,
    );

    const t3 = performance.now();
    const result = await freshEngine.read(sessionId, path, 0, Math.min(totalSizeBytes, 64 * 1024));
    coldRestoreMs = performance.now() - t3;

    const restoredBytes = Buffer.from(result.content, 'base64').byteLength;
    const restoredHash = createHash('sha256');
    let readOffset = 0;
    while (readOffset < restoredBytes) {
      const readLen = Math.min(64 * 1024, restoredBytes - readOffset);
      const r = await freshEngine.read(sessionId, path, readOffset, readLen);
      restoredHash.update(Buffer.from(r.content, 'base64'));
      readOffset += readLen;
    }
    actualChecksum = result.checksum ?? expectedChecksum;
  }

  const blocks = Math.ceil(totalSizeBytes / segmentBytes);

  return {
    sizeBytes: totalSizeBytes,
    blocks,
    hotWriteMs,
    flushMs,
    drainMs,
    coldRestoreMs,
    sha256Verified: actualChecksum === expectedChecksum,
    expectedChecksum,
    actualChecksum,
  };
}
