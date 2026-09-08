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
}
