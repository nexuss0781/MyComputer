import type { SupabaseClient } from '@supabase/supabase-js';
import type { JournalStore, OplogRecord } from './oplog.js';

interface OpRow {
  op_id: string;
  session_id: string;
  op_type: string;
  input: unknown;
  result: unknown;
  status: string;
  duration_ms: number;
  created_at: string;
}

export class SupabaseJournalStore implements JournalStore {
  constructor(private readonly db: SupabaseClient) {}

  async insert(record: OplogRecord): Promise<void> {
    const row: OpRow = {
      op_id: record.opId,
      session_id: record.sessionId,
      op_type: record.opType,
      input: record.input,
      result: record.result,
      status: record.status,
      duration_ms: record.durationMs,
      created_at: record.createdAt,
    };
    const { error } = await this.db.from('operations').insert(row);
    if (error) throw new Error(`operations insert failed: ${error.message}`);
  }

  async countForSession(sessionId: string): Promise<number> {
    const { count, error } = await this.db
      .from('operations')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', sessionId);
    if (error) throw new Error(`operations count failed: ${error.message}`);
    return count ?? 0;
  }

  async allAfter(sessionId: string, after: Date): Promise<OplogRecord[]> {
    const { data, error } = await this.db
      .from('operations')
      .select('op_id, session_id, op_type, input, result, status, duration_ms, created_at')
      .eq('session_id', sessionId)
      .gt('created_at', after.toISOString())
      .order('created_at', { ascending: true });
    if (error) throw new Error(`operations select-after failed: ${error.message}`);
    return (data as OpRow[]).map((row) => ({
      opId: row.op_id,
      sessionId: row.session_id,
      opType: row.op_type,
      input: row.input,
      result: row.result,
      status: (row.status ?? 'ok') as OplogRecord['status'],
      durationMs: row.duration_ms ?? 0,
      createdAt: row.created_at,
    }));
  }
}
