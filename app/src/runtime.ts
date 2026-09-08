import { loadEnv } from '@mycomputer/shared';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { BatchBackend } from '../core/batch-backend.js';
import {
  BufferedExecStore,
  Executor,
  MemoryExecStore,
  SupabaseExecStore,
} from '../core/executor.js';
import { FsEngine } from '../core/fs-engine.js';
import { SupabaseJournalStore } from '../core/journal-supabase.js';
import { MemoryBackend } from '../core/memory-backend.js';
import { MemoryJournalStore, Oplog } from '../core/oplog.js';
import type { SelftestEnvironment } from '../core/selftest.js';
import { SupabaseBackend } from '../core/supabase-backend.js';
import { SupabaseSyncStateStore, SupabaseSyncTarget } from '../core/sync-supabase.js';
import { SyncWriter, reconcileFromJournal } from '../core/sync.js';
import { MemorySessionStore, type SessionStore, SupabaseSessionStore } from './session.js';

export interface Runtime {
  engine: FsEngine | null;
  sessions: SessionStore;
  executor: Executor | null;
  sync: SyncWriter | null;
  environment: SelftestEnvironment;
}

export interface PersistenceSelftestFactory {
  engine: FsEngine;
  executor: Executor;
  writer: SyncWriter;
  state: SupabaseSyncStateStore;
  journal: Oplog;
  sessions: SessionStore;
  buildCold(): { engine: FsEngine; writer: SyncWriter; executor: Executor };
}

function serviceKey(): string | undefined {
  const env = loadEnv();
  return env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SECRET_KEY;
}

function buildSupabaseClient(url: string, key: string): SupabaseClient {
  return createClient(url, key);
}

interface SupabaseRuntime {
  db: SupabaseClient;
  syncState: SupabaseSyncStateStore;
  journal: Oplog;
  writer: SyncWriter;
  engine: FsEngine;
  executor: Executor;
  sessions: SupabaseSessionStore;
}

let runtimeSingleton: Runtime | null = null;
let supabaseRuntime: SupabaseRuntime | null = null;

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
      sync: null,
      environment: 'memory',
    };
    return runtimeSingleton;
  }

  const db = buildSupabaseClient(url, key);
  const syncState = new SupabaseSyncStateStore(db);
  const journal = new Oplog(new SupabaseJournalStore(db));
  const writer = new SyncWriter({ target: new SupabaseSyncTarget(db, syncState) });

  const engine = new FsEngine(new BatchBackend(new SupabaseBackend(db), writer), journal);
  const executor = new Executor(new BufferedExecStore(new SupabaseExecStore(db), writer));

  supabaseRuntime = {
    db,
    syncState,
    journal,
    writer,
    engine,
    executor,
    sessions: new SupabaseSessionStore(db),
  };
  runtimeSingleton = {
    engine,
    sessions: supabaseRuntime.sessions,
    executor,
    sync: writer,
    environment: 'supabase',
  };
  return runtimeSingleton;
}

export function reconcileAllPending(): Promise<number> {
  const factory = persistenceSelftestFactory();
  if (!factory) return Promise.resolve(0);
  return factory.sessions.list().then(async (sessions) => {
    const { writer, journal, state } = factory;
    let replayed = 0;
    for (const session of sessions) {
      replayed += await reconcileFromJournal({ writer, journal, state, sessionId: session.id });
    }
    return replayed;
  });
}

export function persistenceSelftestFactory(): PersistenceSelftestFactory | null {
  getRuntime();
  const sup = supabaseRuntime;
  if (!sup) return null;
  const { db, syncState, journal, writer, engine, executor, sessions } = sup;
  return {
    engine,
    executor,
    writer,
    state: syncState,
    journal,
    sessions,
    buildCold() {
      const coldState = new SupabaseSyncStateStore(db);
      const coldWriter = new SyncWriter({ target: new SupabaseSyncTarget(db, coldState) });
      return {
        engine: new FsEngine(
          new BatchBackend(new SupabaseBackend(db), coldWriter),
          new Oplog(new SupabaseJournalStore(db)),
        ),
        writer: coldWriter,
        executor: new Executor(new BufferedExecStore(new SupabaseExecStore(db), coldWriter)),
      };
    },
  };
}

export function resetRuntime(): void {
  runtimeSingleton?.sync?.stop();
  runtimeSingleton = null;
  supabaseRuntime = null;
}
