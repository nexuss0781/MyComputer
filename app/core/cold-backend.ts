import type { Inode } from '@nexuss0781/shared';
import type { BlockRow, FsBackend } from './backend.js';
import type { Chunk } from './chunker.js';
import type { TelegramSink } from './sync-telegram.js';

/**
 * FsBackend decorator that restores cold (pruned) content from Telegram on
 * read. All metadata and write ops delegate to the durable backend unchanged;
 * only getBlocks consults the sink when a block's hot bytes are gone.
 *
 * Assumes the durable backend is a SupabaseBackend that returns BlockRow[]
 * for hot content; pruned rows surface as {data: empty}. When data is empty
 * we treat the whole path as cold and rebuild it through restorePath.
 */
export class ColdBackend implements FsBackend {
  constructor(
    private readonly durable: FsBackend,
    private readonly sink: TelegramSink,
  ) {}

  getInode(sessionId: string, path: string): Promise<Inode | null> {
    return this.durable.getInode(sessionId, path);
  }

  getSessionInodes(sessionId: string): Promise<Inode[]> {
    return this.durable.getSessionInodes(sessionId);
  }

  upsertInode(inode: Inode): Promise<void> {
    return this.durable.upsertInode(inode);
  }

  removeInodes(sessionId: string, paths: string[]): Promise<void> {
    return this.durable.removeInodes(sessionId, paths);
  }

  async getBlocks(sessionId: string, path: string): Promise<BlockRow[]> {
    const hot = await this.durable.getBlocks(sessionId, path);
    const hasHotBytes = hot.some((b) => b.data.byteLength > 0);
    if (hasHotBytes) return hot;
    const restored = await this.sink.restorePath(sessionId, path);
    if (!restored.restored) return [];
    const { bytes, checksum } = restored.restored;
    return [{ seq: 0, size: bytes.byteLength, checksum, data: bytes }];
  }

  insertBlocks(sessionId: string, path: string, contentId: string, chunks: Chunk[]): Promise<void> {
    return this.durable.insertBlocks(sessionId, path, contentId, chunks);
  }

  removeBlocksByPaths(sessionId: string, paths: string[]): Promise<void> {
    return this.durable.removeBlocksByPaths(sessionId, paths);
  }

  renameBlockPath(sessionId: string, fromPath: string, toPath: string): Promise<void> {
    return this.durable.renameBlockPath(sessionId, fromPath, toPath);
  }

  deleteSessionData(sessionId: string): Promise<void> {
    return this.durable.deleteSessionData(sessionId);
  }
}
