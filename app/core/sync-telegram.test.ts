import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MockBridge } from './mock-bridge.js';
import type { BlockRef } from './sync-supabase.js';
import type { TgSinkTarget } from './sync-telegram.js';
import { TelegramSink } from './sync-telegram.js';

const sid = '00000000-0000-0000-0000-000000000001';

function ref(seq: number, checksum: string, data: Uint8Array): BlockRef {
  return {
    contentId: `c-${seq}`,
    seq,
    size: data.byteLength,
    checksum,
    data,
    tgMsgId: null,
    fileId: null,
  };
}

class FakeTarget implements TgSinkTarget {
  rows = new Map<string, BlockRef[]>();
  annotateCalls: Array<{ contentId: string; seq: number; tgMsgId: number; fileId: string }> = [];

  async dirtyPaths(sessionId?: string): Promise<Array<{ sessionId: string; path: string }>> {
    const out: Array<{ sessionId: string; path: string }> = [];
    for (const [key, refs] of this.rows) {
      const [s, p] = key.split('::');
      if (sessionId && s !== sessionId) continue;
      const anyDirty = refs.some((r) => r.tgMsgId === null);
      if (anyDirty) out.push({ sessionId: s, path: p });
    }
    return out;
  }

  async blockRefs(sessionId: string, path: string): Promise<BlockRef[]> {
    return [...(this.rows.get(`${sessionId}::${path}`) ?? [])].map((r) => ({ ...r }));
  }

  async annotateTgMsg(
    rows: Array<{ contentId: string; seq: number; tgMsgId: number; fileId: string }>,
  ): Promise<void> {
    this.annotateCalls.push(...rows);
    for (const a of rows) {
      for (const refs of this.rows.values()) {
        const idx = refs.findIndex((r) => r.contentId === a.contentId && r.seq === a.seq);
        if (idx >= 0) {
          const existing = refs[idx];
          if (existing) refs[idx] = { ...existing, tgMsgId: a.tgMsgId, fileId: a.fileId };
        }
      }
    }
  }
}

const checksum = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

describe('TelegramSink', () => {
  it('uploads dirty chunks in seq order and annotates', async () => {
    const bridge = new MockBridge();
    const target = new FakeTarget();
    target.rows.set(`${sid}::/a.txt`, [
      ref(0, checksum(new Uint8Array([1])), new Uint8Array([1])),
      ref(1, checksum(new Uint8Array([2])), new Uint8Array([2])),
    ]);
    const sink = new TelegramSink(bridge, target);
    const stats = await sink.drain();
    expect(stats.paths).toBe(1);
    expect(stats.chunks).toBe(2);
    expect(stats.manifests).toBe(1);
    expect(bridge.uploads.map((u) => u.meta.seq)).toEqual([0, 1]);
    expect(target.annotateCalls.length).toBe(2);
  });

  it('is idempotent: already-annotated chunks are not re-uploaded', async () => {
    const bridge = new MockBridge();
    const target = new FakeTarget();
    target.rows.set(`${sid}::/a.txt`, [ref(0, checksum(new Uint8Array([1])), new Uint8Array([1]))]);
    const sink = new TelegramSink(bridge, target);
    const first = await sink.drain();
    expect(first.chunks).toBe(1);
    const second = await sink.drain();
    expect(second.chunks).toBe(0);
    expect(bridge.uploads.length).toBe(1);
  });

  it('retries a transient upload failure and continues', async () => {
    const bridge = new MockBridge();
    bridge.failUpload = true;
    const target = new FakeTarget();
    target.rows.set(`${sid}::/a.txt`, [ref(0, checksum(new Uint8Array([1])), new Uint8Array([1]))]);
    const sink = new TelegramSink(bridge, target, { retries: 0 });
    await expect(sink.drain()).rejects.toThrow('mock upload failure');
  });

  it('restorePath reassembles pruned multi-chunk content in order', async () => {
    const bridge = new MockBridge();
    const target = new FakeTarget();
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    target.rows.set(`${sid}::/m.bin`, [ref(0, checksum(a), a), ref(1, checksum(b), b)]);
    const sink = new TelegramSink(bridge, target);
    await sink.drain();
    target.rows.set(`${sid}::/m.bin`, [
      {
        ...ref(0, checksum(a), new Uint8Array(0)),
        data: null,
        tgMsgId: 1,
        fileId: 'MOCK_FILE_1000',
      },
      {
        ...ref(1, checksum(b), new Uint8Array(0)),
        data: null,
        tgMsgId: 2,
        fileId: 'MOCK_FILE_1001',
      },
    ]);
    const result = await sink.restorePath(sid, '/m.bin');
    expect(result.restored?.bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('throws on checksum mismatch during restore', async () => {
    const bridge = new MockBridge();
    const target = new FakeTarget();
    const a = new Uint8Array([1, 2, 3]);
    target.rows.set(`${sid}::/g.bin`, [ref(0, checksum(a), a)]);
    const sink = new TelegramSink(bridge, target);
    await sink.drain();
    // corrupt the stored bytes after upload so checksum differs
    const entry = bridge.uploads[0];
    entry.data = new Uint8Array([9, 9, 9]);
    target.rows.set(`${sid}::/g.bin`, [
      { ...ref(0, checksum(a), new Uint8Array(0)), data: null, tgMsgId: 1, fileId: entry.fileId },
    ]);
    await expect(sink.restorePath(sid, '/g.bin')).rejects.toThrow('checksum mismatch');
  });

  it('reports disabled when bridge unavailable', async () => {
    const bridge = new MockBridge();
    bridge.enabled = false;
    const sink = new TelegramSink(bridge, new FakeTarget());
    const stats = await sink.drain();
    expect(stats.disabled).toBe(true);
    expect(stats.chunks).toBe(0);
  });
});
