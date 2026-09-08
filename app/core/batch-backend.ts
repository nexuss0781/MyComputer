import type { Inode } from '@mycomputer/shared';
import type { BlockRow, FsBackend } from './backend.js';
import type { Chunk } from './chunker.js';
import type { PendingBlockState, SyncWriter } from './sync.js';

/**
 * FsBackend adapter that overlays the SyncWriter's in-flight mutations on top
 * of a durable backend. Mutations enqueue into the writer (batched, journal
 * already recorded); reads resolve unflushed state from memory first so
 * read-after-write within an instance is sub-millisecond and consistent.
 */
export class BatchBackend implements FsBackend {
  constructor(
    private readonly durable: FsBackend,
    private readonly writer: SyncWriter,
  ) {}

  async getInode(sessionId: string, path: string): Promise<Inode | null> {
    if (this.writer.removed(sessionId, path)) return null;
    const pending = this.writer.inode(sessionId, path);
    if (pending) return { ...pending };
    return this.durable.getInode(sessionId, path);
  }

  async getSessionInodes(sessionId: string): Promise<Inode[]> {
    const durable = await this.durable.getSessionInodes(sessionId);
    const map = new Map<string, Inode>();
    for (const n of durable) map.set(n.path, n);
    for (const n of this.writer.allInodes(sessionId)) {
      if (this.writer.removed(sessionId, n.path)) map.delete(n.path);
      else map.set(n.path, n);
    }
    return [...map.values()];
  }

  async upsertInode(inode: Inode): Promise<void> {
    this.writer.queueUpsertInode(inode);
  }

  async removeInodes(sessionId: string, paths: string[]): Promise<void> {
    this.writer.queueRemovePaths(sessionId, paths);
  }

  async getBlocks(sessionId: string, path: string): Promise<BlockRow[]> {
    if (this.writer.removed(sessionId, path)) return [];
    const pending = this.writer.blocks(sessionId, path);
    if (pending) return pending.map((r) => ({ ...r }));
    return this.durable.getBlocks(sessionId, path);
  }

  async insertBlocks(
    sessionId: string,
    path: string,
    _contentId: string,
    chunks: Chunk[],
  ): Promise<void> {
    if (chunks.length === 0) {
      this.writer.queueRemovePaths(sessionId, [path]);
      return;
    }
    const rows: PendingBlockState[] = chunks.map((c) => ({
      sessionId,
      path,
      seq: c.seq,
      size: c.size,
      checksum: c.checksum,
      data: c.data,
    }));
    this.writer.queuePushBlocks(rows);
  }

  async removeBlocksByPaths(sessionId: string, paths: string[]): Promise<void> {
    this.writer.queueRemoveBlocks(sessionId, paths);
  }

  async renameBlockPath(sessionId: string, fromPath: string, toPath: string): Promise<void> {
    const rows = await this.getBlocks(sessionId, fromPath);
    this.writer.queueRemoveBlocks(sessionId, [fromPath]);
    if (rows.length > 0) {
      this.writer.queuePushBlocks(rows.map((r) => ({ ...r, sessionId, path: toPath })));
    }
  }

  async deleteSessionData(sessionId: string): Promise<void> {
    this.writer.queueRemoveSessionData(sessionId);
  }
}
