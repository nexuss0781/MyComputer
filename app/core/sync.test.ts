import type { Execution, Inode } from '@mycomputer/shared';
import { describe, expect, it } from 'vitest';
import type { BlockRow } from './supabase-backend.js';
import type { PendingBlockState } from './sync.js';
import { type SyncStateStore, type SyncTarget, SyncWriter, reconcileFromJournal } from './sync.js';

interface FakeTargetState {
  inodes: Map<string, Inode>;
  blocks: Map<string, { rows: BlockRow[] }>;
  executions: Map<string, Execution>;
  removed: string[];
  calls: { key: string; rows: number }[];
}

function makeFakeTarget(): {
  target: SyncTarget & { state: FakeTargetState };
  state: FakeTargetState;
} {
  const state: FakeTargetState = {
    inodes: new Map(),
    blocks: new Map(),
    executions: new Map(),
    removed: [],
    calls: [],
  };
  const key = (sessionId: string, path: string) => `${sessionId}::${path}`;
  const target: SyncTarget & { state: FakeTargetState } = {
    state,
    async persistInodes(inodes) {
      state.calls.push({ key: 'persistInodes', rows: inodes.length });
      for (const inode of inodes) state.inodes.set(key(inode.sessionId, inode.path), inode);
    },
    async removeInodes(sessionId: string, paths: string[]) {
      state.calls.push({ key: 'removeInodes', rows: paths.length });
      for (const path of paths) {
        const k = key(sessionId, path);
        state.inodes.delete(k);
        state.removed.push(k);
      }
    },
    async removeBlocks(sessionId: string, paths: string[]) {
      state.calls.push({ key: 'removeBlocks', rows: paths.length });
      for (const path of paths) {
        const k = key(sessionId, path);
        state.blocks.delete(k);
        state.removed.push(k);
      }
    },
    async insertBlocks(rows) {
      state.calls.push({ key: 'insertBlocks', rows: rows.length });
      for (const row of rows) {
        state.blocks.set(key(row.sessionId, row.path), { rows: [row] });
      }
    },
    async insertExecutions(executions) {
      state.calls.push({ key: 'insertExecutions', rows: executions.length });
      for (const execution of executions) {
        state.executions.set(`${execution.sessionId}::${execution.execId}`, execution);
      }
    },
    async removeSessionData(_sessionId) {
      state.calls.push({ key: 'removeSessionData', rows: 0 });
    },
  };
  return { target, state };
}

function makeStateStore(): SyncStateStore & { marks: Date[] } {
  const marks: Date[] = [];
  return {
    marks,
    async get(_sessionId) {
      return marks[0] ?? null;
    },
    async set(_sessionId, at) {
      marks[0] = at;
    },
    async clear(_sessionId) {
      marks[0] = undefined as unknown as Date;
    },
  };
}

function inode(sessionId: string, path: string, type: 'file' | 'dir' = 'file'): Inode {
  return {
    path,
    sessionId,
    type,
    mode: 420,
    size: 3,
    mime: null,
    checksum: 'abc',
    parent: '/',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

function blocksFor(sessionId: string, path: string, n = 2): PendingBlockState[] {
  const rows: BlockRow[] = Array.from({ length: n }, (_, i) => ({
    session_id: sessionId,
    path,
    seq: i,
    size: 3,
    checksum: `c${i}`,
    content_id: `x${i}`,
    data: Buffer.from('abc').toString('hex'),
  }));
  return rows.map((r) => ({ ...r, sessionId, path }));
}

const exec = (sessionId: string, execId: string): Execution => ({
  execId,
  sessionId,
  command: 'echo x',
  status: 'ok',
  stdout: 'x',
  stderr: '',
  exitCode: 0,
  timedOut: false,
  durationMs: 1,
  createdAt: '2024-01-01T00:00:00.000Z',
});

describe('sync writer', () => {
  it('overlay: read-after-write sees pending mutations without flushing', async () => {
    const { target, state } = makeFakeTarget();
    const writer = new SyncWriter({ target });
    const sid = 's1';
    writer.queueUpsertInode(inode(sid, '/f.txt'));
    writer.queuePushBlocks(blocksFor(sid, '/f.txt', 1));

    expect(writer.inode(sid, '/f.txt')).not.toBeNull();
    expect(state.inodes.size).toBe(0);
    expect(writer.blocks(sid, '/f.txt')?.length).toBe(1);
    expect(state.blocks.size).toBe(0);
  });

  it('flush persists and clears the buffer', async () => {
    const { target, state } = makeFakeTarget();
    const writer = new SyncWriter({ target });
    const sid = 's1';
    writer.queueUpsertInode(inode(sid, '/f.txt'));
    writer.queuePushBlocks(blocksFor(sid, '/f.txt', 2));
    writer.queueInsertExecution(sid, exec(sid, 'e1'));

    await writer.flush();

    expect(state.inodes.size).toBe(1);
    expect(state.blocks.size).toBe(1);
    expect(state.executions.size).toBe(1);
    expect(writer.size()).toBe(0);
    expect(writer.inode(sid, '/f.txt')).toBeUndefined();
  });

  it('flush collapses N writes to constant-round excluded calls', async () => {
    const { target, state } = makeFakeTarget();
    const writer = new SyncWriter({ target });
    const sid = 's1';
    for (let i = 0; i < 100; i++) {
      writer.queueUpsertInode(inode(sid, `/f${i}.txt`));
      writer.queuePushBlocks(blocksFor(sid, `/f${i}.txt`, 1));
    }

    await writer.flush();

    expect(state.calls.filter((c) => c.key === 'persistInodes').length).toBe(1);
    expect(state.calls.filter((c) => c.key === 'insertBlocks').length).toBe(1);
  });

  it('flush with a failing target retains the buffer for retry', async () => {
    let fail = true;
    const flaky: SyncTarget = {
      async persistInodes() {
        if (fail) throw new Error('boom');
      },
      async removeInodes() {},
      async removeBlocks() {},
      async insertBlocks() {},
      async insertExecutions() {},
      async removeSessionData() {},
    };
    const writer = new SyncWriter({ target: flaky }, { retries: 1 });
    const sid = 's1';
    writer.queueUpsertInode(inode(sid, '/f.txt'));

    await expect(writer.flush()).rejects.toThrow(/flush incomplete/);

    fail = false;
    const stats = await writer.flush();
    expect(stats.flushed).toBeGreaterThan(0);
    expect(writer.size()).toBe(0);
  });

  it('removePath clears pending bytes and marks removal', async () => {
    const { target, state } = makeFakeTarget();
    const writer = new SyncWriter({ target });
    const sid = 's1';
    writer.queueUpsertInode(inode(sid, '/a'));
    writer.queuePushBlocks(blocksFor(sid, '/a', 1));
    writer.queueRemoveBlocks(sid, ['/a']);

    expect(writer.inode(sid, '/a')).not.toBeNull();
    expect(writer.blocks(sid, '/a')).toBeUndefined();
    expect(writer.removed(sid, '/a')).toBe(true);

    await writer.flush();
    expect(writer.size()).toBe(0);
    expect(state.blocks.size).toBe(0);
  });

  it('session delete flushes stdin before removing the session row', async () => {
    const { target, state } = makeFakeTarget();
    const writer = new SyncWriter({ target });
    const sid = 's1';
    writer.queueUpsertInode(inode(sid, '/f.txt'));
    writer.queueRemoveSessionData(sid);

    await writer.flush();

    expect(writer.size()).toBe(0);
    expect(state.inodes.size).toBe(0);
  });
});

describe('reconcile from journal', () => {
  it('replays write ops after the watermark and advances it', async () => {
    const { target, state } = makeFakeTarget();
    const writer = new SyncWriter({ target });
    const stateStore = makeStateStore();
    const sid = 's1';
    const ops = [
      {
        opId: '1',
        opType: 'write',
        sessionId: sid,
        input: {
          path: '/f.txt',
          bytes: 3,
          content: Buffer.from('abc').toString('base64'),
        },
        result: { path: '/f.txt', size: 3, checksum: 'c', blocks: 1 },
        status: 'ok',
        durationMs: 1,
        createdAt: '2024-01-02T00:00:00.000Z',
      },
    ];
    const journal = {
      async allAfter(_sid: string, after: Date): Promise<typeof ops> {
        expect(after.toISOString()).toBe('1970-01-01T00:00:00.000Z');
        return ops;
      },
    };

    const replayed = await reconcileFromJournal({
      writer,
      journal,
      state: stateStore,
      sessionId: sid,
    });

    expect(replayed).toBe(1);
    expect(writer.size()).toBe(0);
    expect(state.inodes.size).toBe(1);
    expect(stateStore.marks.length).toBe(1);
    expect(stateStore.marks[0]?.toISOString()).toBe(ops[0].createdAt);
  });

  it('replays only byte-content ops, not exec ops', async () => {
    const { target, state } = makeFakeTarget();
    const writer = new SyncWriter({ target });
    const stateStore = makeStateStore();
    const sid = 's1';
    const ops = [
      {
        opId: '1',
        opType: 'exec',
        sessionId: sid,
        input: { command: 'echo hi' },
        result: { execId: 'e9', exitCode: 0 },
        status: 'ok',
        durationMs: 1,
        createdAt: '2024-01-02T00:00:01.000Z',
      },
      {
        opId: '2',
        opType: 'write',
        sessionId: sid,
        input: {
          path: '/f.txt',
          bytes: 3,
          content: Buffer.from('abc').toString('base64'),
        },
        result: { path: '/f.txt', size: 3, checksum: 'c', blocks: 1 },
        status: 'ok',
        durationMs: 1,
        createdAt: '2024-01-02T00:00:02.000Z',
      },
    ];
    const journal = {
      async allAfter(): Promise<typeof ops> {
        return ops;
      },
    };

    const replayed = await reconcileFromJournal({
      writer,
      journal,
      state: stateStore,
      sessionId: sid,
    });

    expect(replayed).toBe(1);
    expect(state.inodes.size).toBe(1);
    expect(state.executions.size).toBe(0);
    expect(stateStore.marks[0]?.toISOString()).toBe('2024-01-02T00:00:02.000Z');
  });
});
