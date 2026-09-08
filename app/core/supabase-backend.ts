import type { Inode } from '@mycomputer/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BlockRow, FsBackend } from './backend.js';
import type { Chunk } from './chunker.js';

interface InodeRow {
  path: string;
  session_id: string;
  type: 'file' | 'dir';
  mode: number;
  size: number;
  mime: string | null;
  checksum: string | null;
  parent: string | null;
  created_at: string;
  updated_at: string;
}

interface BlockRowRaw {
  seq: number;
  size: number;
  checksum: string;
  data: string | null;
}

const asB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const fromB64 = (value: string | null) =>
  value ? Buffer.from(value, 'base64') : new Uint8Array(0);

export function inodeFromRow(row: InodeRow): Inode {
  return {
    path: row.path,
    sessionId: row.session_id,
    type: row.type,
    mode: row.mode,
    size: row.size,
    mime: row.mime,
    checksum: row.checksum,
    parent: row.parent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SupabaseBackend implements FsBackend {
  constructor(private readonly db: SupabaseClient) {}

  async getInode(sessionId: string, path: string): Promise<Inode | null> {
    const { data, error } = await this.db
      .from('inodes')
      .select('*')
      .eq('session_id', sessionId)
      .eq('path', path)
      .maybeSingle();
    if (error) throw new Error(`inode select failed: ${error.message}`);
    return data ? inodeFromRow(data as InodeRow) : null;
  }

  async getSessionInodes(sessionId: string): Promise<Inode[]> {
    const { data, error } = await this.db.from('inodes').select('*').eq('session_id', sessionId);
    if (error) throw new Error(`inode list failed: ${error.message}`);
    return (data as InodeRow[]).map(inodeFromRow);
  }

  async upsertInode(inode: Inode): Promise<void> {
    const row: InodeRow = {
      path: inode.path,
      session_id: inode.sessionId,
      type: inode.type,
      mode: inode.mode,
      size: inode.size,
      mime: inode.mime,
      checksum: inode.checksum,
      parent: inode.parent,
      created_at: inode.createdAt,
      updated_at: inode.updatedAt,
    };
    const { error } = await this.db.from('inodes').upsert(row, {
      onConflict: 'session_id,path',
      ignoreDuplicates: false,
    });
    if (error) throw new Error(`inode upsert failed: ${error.message}`);
  }

  async removeInodes(sessionId: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const { error } = await this.db
      .from('inodes')
      .delete()
      .eq('session_id', sessionId)
      .in('path', paths);
    if (error) throw new Error(`inode delete failed: ${error.message}`);
  }

  async getBlocks(sessionId: string, path: string): Promise<BlockRow[]> {
    const { data, error } = await this.db
      .from('blocks')
      .select('seq,size,checksum,data')
      .eq('session_id', sessionId)
      .eq('path', path)
      .order('seq');
    if (error) throw new Error(`blocks select failed: ${error.message}`);
    return (data as BlockRowRaw[]).map((row) => ({
      seq: row.seq,
      size: row.size,
      checksum: row.checksum,
      data: fromB64(row.data),
    }));
  }

  async insertBlocks(
    sessionId: string,
    path: string,
    contentId: string,
    chunks: Chunk[],
  ): Promise<void> {
    await this.removeBlocksByPaths(sessionId, [path]);
    if (chunks.length === 0) return;
    const rows = chunks.map((c) => ({
      content_id: contentId,
      path,
      session_id: sessionId,
      seq: c.seq,
      size: c.size,
      checksum: c.checksum,
      data: asB64(c.data),
    }));
    const { error } = await this.db.from('blocks').insert(rows);
    if (error) throw new Error(`blocks insert failed: ${error.message}`);
  }

  async removeBlocksByPaths(sessionId: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const { error } = await this.db
      .from('blocks')
      .delete()
      .eq('session_id', sessionId)
      .in('path', paths);
    if (error) throw new Error(`blocks delete failed: ${error.message}`);
  }

  async renameBlockPath(sessionId: string, fromPath: string, toPath: string): Promise<void> {
    const { error } = await this.db
      .from('blocks')
      .update({ path: toPath })
      .eq('session_id', sessionId)
      .eq('path', fromPath);
    if (error) throw new Error(`blocks rename failed: ${error.message}`);
  }

  async deleteSessionData(sessionId: string): Promise<void> {
    const { error: e1 } = await this.db.from('blocks').delete().eq('session_id', sessionId);
    const { error: e2 } = await this.db.from('inodes').delete().eq('session_id', sessionId);
    if (e1 || e2) {
      throw new Error(
        `session cleanup failed: ${[e1?.message, e2?.message].filter(Boolean).join(' | ')}`,
      );
    }
  }
}
