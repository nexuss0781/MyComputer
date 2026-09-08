import { randomUUID } from 'node:crypto';
import type { Inode } from '@mycomputer/shared';
import type { Execution } from '@mycomputer/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
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
    const payload = rows.map((r) => ({
      content_id: randomUUID(),
      path: r.path,
      session_id: r.sessionId,
      seq: r.seq,
      size: r.size,
      checksum: r.checksum,
      data: toByteaBytes(r.data),
    }));
    const { error } = await this.db.from('blocks').insert(payload);
    if (error) throw new Error(`blocks batch insert failed: ${error.message}`);
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
}
