import type { Inode } from '@nexuss0781/shared';
import type { Execution } from '@nexuss0781/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { uuidFromSeed } from './ids.js';
import type { PendingBlockState, SyncStateStore, SyncTarget } from './sync.js';

const toBytea = (value: string) => `\\x${Buffer.from(value).toString('hex')}`;
const toByteaBytes = (bytes: Uint8Array) => `\\x${Buffer.from(bytes).toString('hex')}`;

interface SyncStateRow {
  session_id: string;
  flushed_at: string;
}

export class SupabaseSyncStateStore implements SyncStateStore {
  constructor(private readonly db: SupabaseClient) {}

  async get(sessionId: string): Promise<Date | null> {
    const { data, error } = await this.db
      .from('sync_state')
      .select('*')
      .eq('session_id', sessionId)
      .maybeSingle();
    if (error) throw new Error(`sync_state select failed: ${error.message}`);
    if (!data) return null;
    return new Date((data as SyncStateRow).flushed_at);
  }

  async set(sessionId: string, at: Date): Promise<void> {
    const { error } = await this.db
      .from('sync_state')
      .upsert(
        { session_id: sessionId, flushed_at: at.toISOString() },
        { onConflict: 'session_id' },
      );
    if (error) throw new Error(`sync_state upsert failed: ${error.message}`);
  }

  async clear(sessionId: string): Promise<void> {
    const { error } = await this.db.from('sync_state').delete().eq('session_id', sessionId);
    if (error) throw new Error(`sync_state clear failed: ${error.message}`);
  }
}

export interface BlockRef {
  contentId: string;
  seq: number;
  size: number;
  checksum: string;
  data: Uint8Array | null;
  tgMsgId: number | null;
  fileId: string | null;
}

export class SupabaseSyncTarget implements SyncTarget {
  constructor(
    private readonly db: SupabaseClient,
    private readonly state: SyncStateStore,
  ) {}

  async persistInodes(inodes: Inode[]): Promise<void> {
    if (inodes.length === 0) return;
    const rows = inodes.map((n) => ({
      path: n.path,
      session_id: n.sessionId,
      type: n.type,
      mode: n.mode,
      size: n.size,
      mime: n.mime,
      checksum: n.checksum,
      parent: n.parent,
      created_at: n.createdAt,
      updated_at: n.updatedAt,
    }));
    const { error } = await this.db.from('inodes').upsert(rows, {
      onConflict: 'session_id,path',
      ignoreDuplicates: false,
    });
    if (error) throw new Error(`inodes batch upsert failed: ${error.message}`);
  }

  async removeInodes(sessionId: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const { error } = await this.db
      .from('inodes')
      .delete()
      .eq('session_id', sessionId)
      .in('path', paths);
    if (error) throw new Error(`inodes batch delete failed: ${error.message}`);
  }

  async removeBlocks(sessionId: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const { error } = await this.db
      .from('blocks')
      .delete()
      .eq('session_id', sessionId)
      .in('path', paths);
    if (error) throw new Error(`blocks batch delete failed: ${error.message}`);
  }

  async insertBlocks(rows: PendingBlockState[]): Promise<void> {
    if (rows.length === 0) return;
    const payload = rows.map((r) => {
      const contentId = uuidFromSeed(`${r.sessionId}::${r.path}::${r.checksum}`);
      return {
        content_id: contentId,
        path: r.path,
        session_id: r.sessionId,
        seq: r.seq,
        size: r.size,
        checksum: r.checksum,
        data: toByteaBytes(r.data),
      };
    });
    const { error } = await this.db.from('blocks').upsert(payload, {
      onConflict: 'content_id,seq',
      ignoreDuplicates: false,
    });
    if (error) throw new Error(`blocks batch upsert failed: ${error.message}`);
  }

  async insertExecutions(executions: Execution[]): Promise<void> {
    if (executions.length === 0) return;
    const payload = executions.map((e) => ({
      exec_id: e.execId,
      session_id: e.sessionId,
      command: e.command,
      cwd: e.cwd,
      stdout: toBytea(e.stdout),
      stderr: toBytea(e.stderr),
      exit_code: e.exitCode,
      duration_ms: e.durationMs,
      created_at: e.createdAt,
    }));
    const { error } = await this.db.from('executions').insert(payload);
    if (error) throw new Error(`executions batch insert failed: ${error.message}`);
  }

  async removeSessionData(sessionId: string): Promise<void> {
    const { error: e1 } = await this.db.from('blocks').delete().eq('session_id', sessionId);
    if (e1) throw new Error(`blocks cleanup failed: ${e1.message}`);
    const { error: e2 } = await this.db.from('inodes').delete().eq('session_id', sessionId);
    if (e2) throw new Error(`inodes cleanup failed: ${e2.message}`);
    const { error: e3 } = await this.db.from('executions').delete().eq('session_id', sessionId);
    if (e3) throw new Error(`executions cleanup failed: ${e3.message}`);
    await this.state.clear(sessionId);
  }

  async dirtyPaths(sessionId?: string): Promise<Array<{ sessionId: string; path: string }>> {
    let query = this.db.from('blocks').select('session_id, path').is('tg_msg_id', null);
    if (sessionId) query = query.eq('session_id', sessionId);
    const { data, error } = await query;
    if (error) throw new Error(`dirty paths query failed: ${error.message}`);
    const rows = data as Array<{ session_id: string; path: string }>;
    const seen = new Set<string>();
    const result: Array<{ sessionId: string; path: string }> = [];
    for (const row of rows) {
      const k = `${row.session_id}::${row.path}`;
      if (!seen.has(k)) {
        seen.add(k);
        result.push({ sessionId: row.session_id, path: row.path });
      }
    }
    return result;
  }

  async blockRefs(sessionId: string, path: string): Promise<BlockRef[]> {
    const { data, error } = await this.db
      .from('blocks')
      .select('content_id, seq, size, checksum, data, tg_msg_id, file_id')
      .eq('session_id', sessionId)
      .eq('path', path)
      .order('seq');
    if (error) throw new Error(`block refs query failed: ${error.message}`);
    return (
      data as Array<{
        content_id: string;
        seq: number;
        size: number;
        checksum: string;
        data: string | null;
        tg_msg_id: number | null;
        file_id: string | null;
      }>
    ).map((r) => ({
      contentId: r.content_id,
      seq: r.seq,
      size: r.size,
      checksum: r.checksum,
      data: r.data ? fromBytea(r.data) : null,
      tgMsgId: r.tg_msg_id,
      fileId: r.file_id,
    }));
  }

  async annotateTgMsg(
    rows: Array<{ contentId: string; seq: number; tgMsgId: number; fileId: string }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    for (const row of rows) {
      const { error } = await this.db
        .from('blocks')
        .update({ tg_msg_id: row.tgMsgId, file_id: row.fileId })
        .eq('content_id', row.contentId)
        .eq('seq', row.seq);
      if (error) throw new Error(`tg_msg annotate failed: ${error.message}`);
    }
  }
}

const fromBytea = (value: string | null) => {
  if (!value) return new Uint8Array(0);
  if (value.startsWith('\\x')) return new Uint8Array(Buffer.from(value.slice(2), 'hex'));
  return new Uint8Array(Buffer.from(value, 'base64'));
};
