import type { Inode } from '@mycomputer/shared';
import { describe, expect, it } from 'vitest';
import type { BlockRow, FsBackend } from './backend.js';
import { BatchBackend } from './batch-backend.js';
import {
  runCorruptionDrill,
  runCrashRecoveryDrill,
  runFlushScaleBench,
  runMicroBench,
} from './bench.js';
import type { Chunk } from './chunker.js';
import { ColdBackend } from './cold-backend.js';
import { FsEngine } from './fs-engine.js';
import { MemoryBackend } from './memory-backend.js';
import { MockBridge } from './mock-bridge.js';
import { MemoryJournalStore, Oplog } from './oplog.js';
import type { BlockRef } from './sync-supabase.js';
import { TelegramSink } from './sync-telegram.js';
import { type PendingBlockState, type SyncTarget, SyncWriter } from './sync.js';

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

class SharedBackendTarget implements SyncTarget {
  private tgAnnotations = new Map<string, { tgMsgId: number; fileId: string }>();
  private drained = new Set<string>();
  constructor(private readonly backend: MemoryBackend) {}

  private k(sid: string, path: string) {
    return `${sid}::${path}`;
  }

  async persistInodes(inodes: Inode[]): Promise<void> {
    for (const inode of inodes) await this.backend.upsertInode(inode);
  }
  async removeInodes(sid: string, paths: string[]): Promise<void> {
    await this.backend.removeInodes(sid, paths);
  }
  async removeBlocks(sid: string, paths: string[]): Promise<void> {
    await this.backend.removeBlocksByPaths(sid, paths);
  }
  async insertBlocks(rows: PendingBlockState[]): Promise<void> {
    const grouped = new Map<string, Chunk[]>();
    for (const row of rows) {
      const key = this.k(row.sessionId, row.path);
      const existing = grouped.get(key) ?? [];
      existing.push({ seq: row.seq, size: row.size, checksum: row.checksum, data: row.data });
      grouped.set(key, existing);
    }
    for (const [key, chunks] of grouped) {
      const sep = key.indexOf('::');
      const sid = key.slice(0, sep);
      const path = key.slice(sep + 2);
      await this.backend.insertBlocks(sid, path, 'test', chunks);
    }
  }
  async insertExecutions(): Promise<void> {}
  async removeSessionData(sid: string): Promise<void> {
    await this.backend.deleteSessionData(sid);
  }

  async dirtyPaths(sessionId?: string): Promise<Array<{ sessionId: string; path: string }>> {
    const all = await this.backend.getSessionInodes(sessionId ?? '');
    const result: Array<{ sessionId: string; path: string }> = [];
    for (const inode of all) {
      if (inode.type !== 'file') continue;
      if (sessionId && inode.sessionId !== sessionId) continue;
      const key = this.k(inode.sessionId, inode.path);
      if (!this.tgAnnotations.has(key)) {
        result.push({ sessionId: inode.sessionId, path: inode.path });
      }
    }
    return sessionId ? result : result.filter((r) => r.sessionId === sessionId);
  }

  async blockRefs(sessionId: string, path: string): Promise<BlockRef[]> {
    const key = this.k(sessionId, path);
    const rows = await this.backend.getBlocks(sessionId, path);
    const ann = this.tgAnnotations.get(key);
    const isDrained = this.drained.has(key);
    return rows.map((r) => ({
      contentId: `test::${sessionId}::${path}::${r.seq}`,
      seq: r.seq,
      size: r.size,
      checksum: r.checksum,
      data: isDrained ? null : r.data,
      tgMsgId: ann?.tgMsgId ?? null,
      fileId: ann?.fileId ?? null,
    }));
  }

  async annotateTgMsg(
    rows: Array<{ contentId: string; seq: number; tgMsgId: number; fileId: string }>,
  ) {
    for (const row of rows) {
      const parts = row.contentId.split('::');
      if (parts.length >= 4) {
        const sid = parts[1];
        const path = parts.slice(2, -1).join('::');
        const key = this.k(sid, path);
        this.tgAnnotations.set(key, { tgMsgId: row.tgMsgId, fileId: row.fileId });
        this.drained.add(key);
      }
    }
  }

  prunePath(sessionId: string, path: string) {
    const key = this.k(sessionId, path);
    this.drained.add(key);
  }
}

class CorruptibleBackend implements FsBackend {
  private corruptPaths = new Map<string, string>();
  private prunedPaths = new Set<string>();

  constructor(private readonly inner: MemoryBackend) {}

  corruptAndPrune(path: string, wrongChecksum: string) {
    this.corruptPaths.set(path, wrongChecksum);
    this.prunedPaths.add(path);
  }

  async getInode(sid: string, path: string) {
    return this.inner.getInode(sid, path);
  }
  async getSessionInodes(sid: string) {
    return this.inner.getSessionInodes(sid);
  }
  async upsertInode(inode: Inode) {
    await this.inner.upsertInode(inode);
  }
  async removeInodes(sid: string, paths: string[]) {
    await this.inner.removeInodes(sid, paths);
  }

  async getBlocks(sid: string, path: string): Promise<BlockRow[]> {
    const rows = await this.inner.getBlocks(sid, path);
    if (this.prunedPaths.has(path)) {
      const wrong = this.corruptPaths.get(path);
      return rows.map((r) => ({
        ...r,
        checksum: wrong ?? r.checksum,
        data: new Uint8Array(0),
      }));
    }
    return rows;
  }

  async insertBlocks(sid: string, path: string, cid: string, chunks: Chunk[]) {
    await this.inner.insertBlocks(sid, path, cid, chunks);
  }
  async removeBlocksByPaths(sid: string, paths: string[]) {
    await this.inner.removeBlocksByPaths(sid, paths);
  }
  async renameBlockPath(sid: string, from: string, to: string) {
    await this.inner.renameBlockPath(sid, from, to);
  }
  async deleteSessionData(sid: string) {
    await this.inner.deleteSessionData(sid);
  }
}

describe('bench micro', () => {
  it('runs micro benchmarks on memory engine', async () => {
    const engine = new FsEngine(new MemoryBackend(), new Oplog(new MemoryJournalStore()));
    const result = await runMicroBench(engine, 200);
    expect(result.bufferAppendUs.length).toBe(200);
    expect(result.mkdirUs.length).toBe(200);
    expect(result.writeSmallUs.length).toBe(200);
    expect(result.bufferAppendUs[0]).toBeGreaterThanOrEqual(0);
    expect(result.mkdirUs[0]).toBeGreaterThanOrEqual(0);
    expect(result.writeSmallUs[0]).toBeGreaterThanOrEqual(0);
  });
});

describe('bench flush-scale', () => {
  it('records flush timing for each row count', async () => {
    const backend = new MemoryBackend();
    const target = new SharedBackendTarget(backend);
    const state = { get: async () => null, set: async () => {}, clear: async () => {} };
    const writer = new SyncWriter({ target, state });
    const result = await runFlushScaleBench(writer, target, [1, 10, 50]);
    expect(result.scale.length).toBe(3);
    expect(result.scale[0]?.rows).toBe(1);
    expect(result.scale[1]?.rows).toBe(10);
    expect(result.scale[2]?.rows).toBe(50);
  });
});

describe('bench crash-recovery drill', () => {
  it('metadata-only journal entries are skipped by reconciliation', async () => {
    const backend = new MemoryBackend();
    const journal = new Oplog(new MemoryJournalStore());
    const state = { get: async () => null, set: async () => {}, clear: async () => {} };
    const target = new SharedBackendTarget(backend);
    const engine = new FsEngine(backend, journal);

    const result = await runCrashRecoveryDrill(engine, journal, state, target, 'crash-test');
    expect(result.replayed).toBe(0);
    expect(result.pass).toBe(true);
  });
});

describe('bench corruption drill', () => {
  it('detects checksum mismatch via ChecksumError', async () => {
    const sharedBackend = new MemoryBackend();
    const durable = new CorruptibleBackend(sharedBackend);
    const bridge = new MockBridge();
    const state = { get: async () => null, set: async () => {}, clear: async () => {} };
    const target = new SharedBackendTarget(sharedBackend);
    const sink = new TelegramSink(bridge, target);
    const coldBackend = new ColdBackend(durable, sink);
    const writer = new SyncWriter({ target, state });
    const engine = new FsEngine(
      new BatchBackend(coldBackend, writer),
      new Oplog(new MemoryJournalStore()),
    );

    const sessionId = 'corrupt-test';
    const path = '/corrupt.bin';
    const content = deterministicBytes(55, 4096);
    await engine.sessionInit(sessionId);
    await engine.write(sessionId, path, content);
    await writer.flush();
    await sink.drain(sessionId);

    durable.corruptAndPrune(
      path,
      '0000000000000000000000000000000000000000000000000000000000000000',
    );

    const result = await runCorruptionDrill(
      engine,
      writer,
      sink,
      target as never,
      {
        from: (_table: string) => ({
          update: (_data: Record<string, unknown>) => ({
            eq: (_col: string, _val: string) => ({
              eq: async (_col2: string, _val2: string) => {
                const rows = (
                  sharedBackend as unknown as {
                    blockStore: Map<
                      string,
                      { seq: number; size: number; checksum: string; data: Uint8Array }[]
                    >;
                  }
                ).blockStore;
                for (const [, blocks] of rows) {
                  for (const block of blocks) {
                    block.checksum =
                      '0000000000000000000000000000000000000000000000000000000000000000';
                  }
                }
                return { error: null };
              },
            }),
          }),
        }),
      } as never,
      async (sid: string, p: string) => {
        target.prunePath(sid, p);
      },
    );

    expect(result.pass).toBe(true);
    expect(result.detected).toBe(true);
  });
});
