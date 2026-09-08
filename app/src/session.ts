import { randomUUID } from 'node:crypto';
import type { SessionRow } from '@mycomputer/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

interface SessionRowRaw {
  id: string;
  name: string;
  created_at: string;
  meta: Record<string, unknown>;
}

export interface SessionStore {
  create(input: { name?: string; meta?: Record<string, unknown> }): Promise<SessionRow>;
  list(): Promise<SessionRow[]>;
  remove(id: string): Promise<boolean>;
}

export class MemorySessionStore implements SessionStore {
  private readonly rows = new Map<string, SessionRow>();

  async create(input: { name?: string; meta?: Record<string, unknown> }): Promise<SessionRow> {
    const row: SessionRow = {
      id: randomUUID(),
      name: input.name ?? 'default',
      createdAt: new Date().toISOString(),
      meta: input.meta ?? {},
    };
    this.rows.set(row.id, row);
    return row;
  }

  async list(): Promise<SessionRow[]> {
    return [...this.rows.values()];
  }

  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

export class SupabaseSessionStore implements SessionStore {
  constructor(private readonly db: SupabaseClient) {}

  async create(input: { name?: string; meta?: Record<string, unknown> }): Promise<SessionRow> {
    const { data, error } = await this.db
      .from('sessions')
      .insert({ id: randomUUID(), name: input.name ?? 'default', meta: input.meta ?? {} })
      .select()
      .single();
    if (error) throw new Error(`session create failed: ${error.message}`);
    const row = data as SessionRowRaw;
    return { id: row.id, name: row.name, createdAt: row.created_at, meta: row.meta };
  }

  async list(): Promise<SessionRow[]> {
    const { data, error } = await this.db.from('sessions').select('*').order('created_at');
    if (error) throw new Error(`session list failed: ${error.message}`);
    return (data as SessionRowRaw[]).map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      meta: row.meta,
    }));
  }

  async remove(id: string): Promise<boolean> {
    const { error } = await this.db.from('sessions').delete().eq('id', id);
    if (error) throw new Error(`session delete failed: ${error.message}`);
    return true;
  }
}
