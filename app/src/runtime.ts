import { loadEnv } from '@mycomputer/shared';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { Executor, MemoryExecStore, SupabaseExecStore } from '../core/executor.js';
import { FsEngine } from '../core/fs-engine.js';
import { SupabaseJournalStore } from '../core/journal-supabase.js';
import { MemoryBackend } from '../core/memory-backend.js';
import { MemoryJournalStore, Oplog } from '../core/oplog.js';
import type { SelftestEnvironment } from '../core/selftest.js';
import { SupabaseBackend } from '../core/supabase-backend.js';
import { MemorySessionStore, type SessionStore, SupabaseSessionStore } from './session.js';

export interface Runtime {
  engine: FsEngine | null;
  sessions: SessionStore;
  executor: Executor | null;
  environment: SelftestEnvironment;
}

function serviceKey(): string | undefined {
  const env = loadEnv();
  return env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SECRET_KEY;
}

function buildSupabaseClient(url: string, key: string): SupabaseClient {
  return createClient(url, key);
}

let runtimeSingleton: Runtime | null = null;

export function getRuntime(): Runtime {
  if (runtimeSingleton) return runtimeSingleton;
  const env = loadEnv();
  const key = serviceKey();
  const url = env.SUPABASE_URL;

  if (!url || !key) {
    const memoryJournal = new Oplog(new MemoryJournalStore());
    runtimeSingleton = {
      engine: new FsEngine(new MemoryBackend(), memoryJournal),
      sessions: new MemorySessionStore(),
      executor: new Executor(new MemoryExecStore()),
      environment: 'memory',
    };
    return runtimeSingleton;
  }

  const db = buildSupabaseClient(url, key);
  const engine = new FsEngine(new SupabaseBackend(db), new Oplog(new SupabaseJournalStore(db)));
  runtimeSingleton = {
    engine,
    sessions: new SupabaseSessionStore(db),
    executor: new Executor(new SupabaseExecStore(db)),
    environment: 'supabase',
  };
  return runtimeSingleton;
}

export function resetRuntime(): void {
  runtimeSingleton = null;
}
