import type { Inode } from '@mycomputer/shared';
import type { Execution } from '@mycomputer/shared';
import type { BlockRow } from './backend.js';
import { chunkBytes, sha256Hex } from './chunker.js';
import type { OplogRecord } from './oplog.js';

export interface PendingBlockState extends BlockRow {
  sessionId: string;
  path: string;
}

export interface SyncStateStore {
  get(sessionId: string): Promise<Date | null>;
  set(sessionId: string, at: Date): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

export interface SyncTarget {
  persistInodes(inodes: Inode[]): Promise<void>;
  removeInodes(sessionId: string, paths: string[]): Promise<void>;
  removeBlocks(sessionId: string, paths: string[]): Promise<void>;
  insertBlocks(rows: PendingBlockState[]): Promise<void>;
  insertExecutions(executions: Execution[]): Promise<void>;
  removeSessionData(sessionId: string): Promise<void>;
}

export interface SyncWriterDeps {
  target: SyncTarget;
}

export interface SyncStats {
  enqueued: number;
  flushed: number;
  failed: number;
}

const retryDelay = (attempt: number) => Math.min(200 * 2 ** attempt, 5000);
const key = (sessionId: string, path: string) => `${sessionId}::${path}`;

interface Delta {
  upsertedInodes: Map<string, Inode>;
  removedInodes: Set<string>;
  removedBlocks: Set<string>;
  insertedBlocks: Map<string, PendingBlockState[]>;
  executions: Map<string, Execution>;
  sessionDeletes: Set<string>;
  lastFlushed: Map<string, number>;
}

export class SyncWriter {
  private readonly delta: Delta = {
    upsertedInodes: new Map(),
    removedInodes: new Set(),
    removedBlocks: new Set(),
    insertedBlocks: new Map(),
    executions: new Map(),
    sessionDeletes: new Set(),
    lastFlushed: new Map(),
  };
  private pending = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopRequested = false;

  constructor(
    private readonly deps: SyncWriterDeps,
    private readonly config: { flushIntervalMs?: number; retries?: number } = {},
  ) {}

  start(): void {
    if (this.timer || this.stopRequested) return;
    const interval = this.config.flushIntervalMs ?? 100;
    this.timer = setInterval(() => void this.flush().catch(() => {}), interval);
    this.timer.unref();
  }

  stop(): void {
    this.stopRequested = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  queueUpsertInode(inode: Inode): void {
    const k = key(inode.sessionId, inode.path);
    this.delta.upsertedInodes.set(k, { ...inode });
    this.delta.removedInodes.delete(k);
    this.delta.removedBlocks.delete(k);
  }

  queuePushBlocks(rows: PendingBlockState[]): void {
    const first = rows[0];
    if (!first) return;
    const k = key(first.sessionId, first.path);
    const existing = this.delta.insertedBlocks.get(k) ?? [];
    this.delta.insertedBlocks.set(k, existing.concat(rows.map((r) => ({ ...r }))));
    this.delta.removedBlocks.delete(k);
  }

  queueRemoveBlocks(sessionId: string, paths: string[]): void {
    for (const path of paths) {
      const k = key(sessionId, path);
      this.delta.insertedBlocks.delete(k);
      this.delta.removedBlocks.add(k);
    }
  }

  queueRemovePaths(sessionId: string, paths: string[]): void {
    for (const path of paths) {
      const k = key(sessionId, path);
      this.delta.upsertedInodes.delete(k);
      this.delta.insertedBlocks.delete(k);
      this.delta.removedInodes.add(k);
      this.delta.removedBlocks.add(k);
    }
  }

  queueInsertExecution(sessionId: string, execution: Execution): void {
    this.delta.executions.set(key(sessionId, execution.execId), execution);
  }

  queueRemoveSessionData(sessionId: string): void {
    this.delta.sessionDeletes.add(sessionId);
    for (const k of [...this.delta.upsertedInodes.keys()])
      if (k.startsWith(`${sessionId}::`)) this.delta.upsertedInodes.delete(k);
    for (const k of [...this.delta.insertedBlocks.keys()])
      if (k.startsWith(`${sessionId}::`)) this.delta.insertedBlocks.delete(k);
    for (const k of [...this.delta.removedInodes])
      if (k.startsWith(`${sessionId}::`)) this.delta.removedInodes.delete(k);
    for (const k of [...this.delta.removedBlocks])
      if (k.startsWith(`${sessionId}::`)) this.delta.removedBlocks.delete(k);
    for (const [k, e] of [...this.delta.executions])
      if (e.sessionId === sessionId) this.delta.executions.delete(k);
  }

  inode(sessionId: string, path: string): Inode | undefined {
    return this.delta.upsertedInodes.get(key(sessionId, path));
  }

  blocks(sessionId: string, path: string): PendingBlockState[] | undefined {
    return this.delta.insertedBlocks.get(key(sessionId, path));
  }

  execution(sessionId: string, execId: string): Execution | undefined {
    return this.delta.executions.get(key(sessionId, execId));
  }

  removed(sessionId: string, path: string): boolean {
    const k = key(sessionId, path);
    return this.delta.removedInodes.has(k) || this.delta.removedBlocks.has(k);
  }

  allInodes(sessionId: string): Inode[] {
    return [...this.delta.upsertedInodes.values()].filter((n) => n.sessionId === sessionId);
  }

  size(): number {
    return (
      this.delta.upsertedInodes.size +
      this.delta.removedInodes.size +
      this.delta.removedBlocks.size +
      this.delta.insertedBlocks.size +
      this.delta.executions.size +
      this.delta.sessionDeletes.size
    );
  }

  lastFlushedAt(sessionId: string): number | undefined {
    return this.delta.lastFlushed.get(sessionId);
  }

  private attemptIf(action: () => Promise<void>): Promise<boolean> {
    const retries = this.config.retries ?? 3;
    return (async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await action();
          return true;
        } catch (error) {
          if (attempt >= retries) {
            void error;
            return false;
          }
          await new Promise((r) => setTimeout(r, retryDelay(attempt)));
        }
      }
    })();
  }

  async flush(): Promise<SyncStats> {
    const enqueuedAtStart = this.size();
    let rounds = 0;
    let previousSize = this.size();
    do {
      const attempted = await this.flushOnce();
      rounds += 1;
      const size = this.size();
      const progressed = size < previousSize;
      previousSize = size;
      if (!attempted || !progressed || size === 0) break;
    } while (rounds < 8);

    const flushed = enqueuedAtStart - this.size();
    const failed = this.size();
    if (failed > 0) {
      const error = new Error(
        `sync flush incomplete: ${flushed} flushed, ${failed} retained in buffer`,
      );
      throw error;
    }
    return { enqueued: enqueuedAtStart, flushed, failed: 0 };
  }

  private async flushOnce(): Promise<boolean> {
    if (this.pending) {
      await new Promise((r) => setTimeout(r, 10));
      if (this.pending) return false;
    }
    const { delta, deps } = this;
    if (this.size() === 0) return false;
    this.pending = true;
    try {
      const { target } = deps;
      const flushedSessions = new Set<string>();

      for (const sessionId of delta.sessionDeletes) {
        const ok = await this.attemptIf(() => target.removeSessionData(sessionId));
        if (ok) {
          flushedSessions.add(sessionId);
          this.dropSessionBuffers(sessionId);
          delta.lastFlushed.set(sessionId, Date.now());
        }
      }
      delta.sessionDeletes.clear();

      const upserted = new Map<string, Inode>();
      for (const inode of delta.upsertedInodes.values())
        upserted.set(key(inode.sessionId, inode.path), inode);
      if (upserted.size > 0) {
        const ok = await this.attemptIf(() => target.persistInodes([...upserted.values()]));
        if (ok) {
          for (const [k, inode] of delta.upsertedInodes) {
            flushedSessions.add(inode.sessionId);
            delta.upsertedInodes.delete(k);
          }
        }
      }

      const removedInodeBySession = this.groupByPath(delta.removedInodes);
      for (const [sessionId, paths] of removedInodeBySession) {
        const ok = await this.attemptIf(() => target.removeInodes(sessionId, paths));
        if (ok) {
          flushedSessions.add(sessionId);
          for (const path of paths) delta.removedInodes.delete(key(sessionId, path));
        }
      }

      const removedBlockBySession = this.groupByPath(delta.removedBlocks);
      for (const [sessionId, paths] of removedBlockBySession) {
        const ok = await this.attemptIf(() => target.removeBlocks(sessionId, paths));
        if (ok) {
          flushedSessions.add(sessionId);
          for (const path of paths) delta.removedBlocks.delete(key(sessionId, path));
        }
      }

      const blockRows = [...delta.insertedBlocks.values()].flat();
      if (blockRows.length > 0) {
        const ok = await this.attemptIf(() => target.insertBlocks(blockRows));
        if (ok) {
          for (const [k, rows] of delta.insertedBlocks) {
            const first = rows[0];
            if (first) flushedSessions.add(first.sessionId);
            delta.insertedBlocks.delete(k);
          }
        }
      }

      const executions = [...delta.executions.values()];
      if (executions.length > 0) {
        const ok = await this.attemptIf(() => target.insertExecutions(executions));
        if (ok) {
          for (const e of executions) {
            flushedSessions.add(e.sessionId);
            delta.executions.delete(key(e.sessionId, e.execId));
          }
        }
      }

      const now = Date.now();
      for (const sessionId of flushedSessions) delta.lastFlushed.set(sessionId, now);
      return true;
    } finally {
      this.pending = false;
    }
  }

  private groupByPath(keys: Set<string>): Map<string, string[]> {
    const bySession = new Map<string, string[]>();
    for (const k of keys) {
      const sep = k.indexOf('::');
      const sessionId = k.slice(0, sep);
      const path = k.slice(sep + 2);
      let list = bySession.get(sessionId);
      if (!list) {
        list = [];
        bySession.set(sessionId, list);
      }
      list.push(path);
    }
    return bySession;
  }

  private dropSessionBuffers(sessionId: string): void {
    for (const k of [...this.delta.upsertedInodes.keys()])
      if (k.startsWith(`${sessionId}::`)) this.delta.upsertedInodes.delete(k);
    for (const k of [...this.delta.insertedBlocks.keys()])
      if (k.startsWith(`${sessionId}::`)) this.delta.insertedBlocks.delete(k);
    for (const k of [...this.delta.removedInodes])
      if (k.startsWith(`${sessionId}::`)) this.delta.removedInodes.delete(k);
    for (const k of [...this.delta.removedBlocks])
      if (k.startsWith(`${sessionId}::`)) this.delta.removedBlocks.delete(k);
    for (const k of [...this.delta.executions.keys()])
      if (k.startsWith(`${sessionId}::`)) this.delta.executions.delete(k);
    this.delta.sessionDeletes.delete(sessionId);
    this.delta.lastFlushed.delete(sessionId);
  }
}

export interface ReconcileContext {
  writer: SyncWriter;
  journal: { allAfter(sessionId: string, after: Date): Promise<OplogRecord[]> };
  state: SyncStateStore;
  sessionId: string;
  maxChunkBytes?: number;
}

const b64 = (value: string) => Buffer.from(value, 'base64');

function contentFromOp(op: OplogRecord): { bytes: Uint8Array; mime: string | null } | null {
  const input = op.input as { content?: string; mime?: string | null } | null;
  const content = input?.content;
  if (typeof content !== 'string') return null;
  const mime = input?.mime ?? null;
  return {
    bytes: new Uint8Array(b64(content)),
    mime,
  };
}

function executionFromOp(op: OplogRecord): Execution | null {
  const result = op.result as Execution | null;
  if (!result || typeof result.execId !== 'string') return null;
  return { ...result, sessionId: op.sessionId };
}

/**
 * Replays journal ops newer than the session's flush watermark back into the
 * SyncWriter and flushes. The journal carries full byte content for
 * write/append ops, so a crash between journal append and batch flush is fully
 * recoverable. Returns the number of ops replayed.
 */
export async function reconcileFromJournal(ctx: ReconcileContext): Promise<number> {
  const { writer, journal, state, sessionId } = ctx;
  const watermark = await state.get(sessionId);
  const after = watermark ?? new Date(0);
  const ops = await journal.allAfter(sessionId, after);
  let replayed = 0;

  for (const op of ops) {
    const playback = contentFromOp(op);
    if (playback) {
      const { bytes, mime } = playback;
      const path = (op.input as { path?: string })?.path ?? '';
      if (!path) continue;
      const checksum = sha256Hex(bytes);
      const chunks = chunkBytes(bytes, ctx.maxChunkBytes ?? 8 * 1024 * 1024);
      writer.queueUpsertInode({
        path,
        sessionId,
        type: 'file',
        mode: 420,
        size: bytes.byteLength,
        mime: mime ?? null,
        checksum,
        parent: (op.input as { parent?: string | null })?.parent ?? null,
        createdAt: op.createdAt,
        updatedAt: op.createdAt,
      });
      writer.queuePushBlocks(
        chunks.map((chunk) => ({
          sessionId,
          path,
          seq: chunk.seq,
          size: chunk.size,
          checksum: chunk.checksum,
          data: chunk.data,
        })),
      );
      replayed += 1;
      continue;
    }

    const execution = executionFromOp(op);
    if (execution) {
      writer.queueInsertExecution(sessionId, execution);
      replayed += 1;
    }
  }

  if (ops.length > 0) {
    if (replayed > 0 || writer.size() > 0) await writer.flush();
    const last = ops[ops.length - 1];
    if (last) await state.set(sessionId, new Date(last.createdAt));
  }
  return replayed;
}
