import type { Inode } from '@nexuss0781/shared';
import type { Chunk } from './chunker.js';

export interface BlockRow {
  seq: number;
  size: number;
  checksum: string;
  data: Uint8Array;
}

export interface FsBackend {
  getSessionInodes(sessionId: string): Promise<Inode[]>;
  getInode(sessionId: string, path: string): Promise<Inode | null>;
  upsertInode(inode: Inode): Promise<void>;
  removeInodes(sessionId: string, paths: string[]): Promise<void>;

  getBlocks(sessionId: string, path: string): Promise<BlockRow[]>;
  insertBlocks(sessionId: string, path: string, contentId: string, chunks: Chunk[]): Promise<void>;
  removeBlocksByPaths(sessionId: string, paths: string[]): Promise<void>;
  renameBlockPath(sessionId: string, fromPath: string, toPath: string): Promise<void>;

  deleteSessionData(sessionId: string): Promise<void>;

  /**
   * Records that every mutation associated with the given journal op has been
   * queued for batch flushing. The flush uses the op's created_at to advance
   * the session watermark on success, so reconcile never replays (and
   * re-materializes) already-flushed writes.
   */
  noteWatermark?(sessionId: string, createdAt: Date): Promise<void>;
}
