import type { Inode } from '@mycomputer/shared';
import type { BlockRow, FsBackend } from './backend.js';
import type { Chunk } from './chunker.js';

const key = (sessionId: string, path: string) => `${sessionId}::${path}`;

export class MemoryBackend implements FsBackend {
  private readonly inodeStore = new Map<string, Inode>();
  private readonly blockStore = new Map<string, BlockRow[]>();

  async getInode(sessionId: string, path: string): Promise<Inode | null> {
    return this.inodeStore.get(key(sessionId, path)) ?? null;
  }

  async getSessionInodes(sessionId: string): Promise<Inode[]> {
    return [...this.inodeStore.values()].filter((node) => node.sessionId === sessionId);
  }

  async upsertInode(inode: Inode): Promise<void> {
    this.inodeStore.set(key(inode.sessionId, inode.path), { ...inode });
  }

  async removeInodes(sessionId: string, paths: string[]): Promise<void> {
    for (const path of paths) this.inodeStore.delete(key(sessionId, path));
  }

  async getBlocks(sessionId: string, path: string): Promise<BlockRow[]> {
    return [...(this.blockStore.get(key(sessionId, path)) ?? [])];
  }

  async insertBlocks(
    sessionId: string,
    path: string,
    _contentId: string,
    chunks: Chunk[],
  ): Promise<void> {
    this.blockStore.set(
      key(sessionId, path),
      chunks.map((c) => ({ seq: c.seq, size: c.size, checksum: c.checksum, data: c.data })),
    );
  }

  async removeBlocksByPaths(sessionId: string, paths: string[]): Promise<void> {
    for (const path of paths) this.blockStore.delete(key(sessionId, path));
  }

  async renameBlockPath(sessionId: string, fromPath: string, toPath: string): Promise<void> {
    const rows = this.blockStore.get(key(sessionId, fromPath));
    if (rows) {
      this.blockStore.delete(key(sessionId, fromPath));
      this.blockStore.set(key(sessionId, toPath), rows);
    }
  }

  async deleteSessionData(sessionId: string): Promise<void> {
    for (const k of [...this.inodeStore.keys()])
      if (k.startsWith(`${sessionId}::`)) this.inodeStore.delete(k);
    for (const k of [...this.blockStore.keys()])
      if (k.startsWith(`${sessionId}::`)) this.blockStore.delete(k);
  }
}
