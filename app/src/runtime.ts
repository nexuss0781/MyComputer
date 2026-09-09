import { BridgeClient } from '@mycomputer/shared';
import { loadEnv } from '@mycomputer/shared';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import type { FsBackend } from '../core/backend.js';
import { BatchBackend } from '../core/batch-backend.js';
import { ColdBackend } from '../core/cold-backend.js';
import {
  BufferedExecStore,
  Executor,
  MemoryExecStore,
  SupabaseExecStore,
} from '../core/executor.js';
import { FsEngine } from '../core/fs-engine.js';
import { SupabaseJournalStore } from '../core/journal-supabase.js';
import { MemoryBackend } from '../core/memory-backend.js';
import { ensureMigrated } from '../core/migrate.js';
import { MockBridge } from '../core/mock-bridge.js';
import { MemoryJournalStore, Oplog } from '../core/oplog.js';
import type { SelftestEnvironment } from '../core/selftest.js';
import { SupabaseBackend } from '../core/supabase-backend.js';
import { SupabaseSyncStateStore, SupabaseSyncTarget } from '../core/sync-supabase.js';
import { TelegramSink } from '../core/sync-telegram.js';
import { SyncWriter, reconcileFromJournal } from '../core/sync.js';
import { MemorySessionStore, type SessionStore, SupabaseSessionStore } from './session.js';

export interface Runtime {
  engine: FsEngine | null;
  sessions: SessionStore;
  executor: Executor | null;
  sync: SyncWriter | null;
  environment: SelftestEnvironment;
  sink: TelegramSink | null;
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

export interface ColdSelftestFactory {
  sessions: SessionStore;
  engine: FsEngine;
  sink: TelegramSink;
  target: SupabaseSyncTarget;
  writePath(sessionId: string, path: string, bytes: Uint8Array): Promise<void>;
  coldRead(sessionId: string, path: string): Promise<string>;
  prunePath(sessionId: string, path: string): Promise<void>;
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
  sink: TelegramSink;
  target: SupabaseSyncTarget;
  durableBackend: FsBackend;
}

let runtimeSingleton: Runtime | null = null;
let supabaseRuntime: SupabaseRuntime | null = null;

const schemaReady: Promise<void> = (() => {
  if (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_PRISMA_URL
  ) {
    return ensureMigrated().catch((error) => {
      console.error('schema migration failed:', error instanceof Error ? error.message : error);
    });
  }
  return Promise.resolve();
})();

export function awaitSchemaReady(): Promise<void> {
  return schemaReady;
}

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
      sink: null,
    };
    return runtimeSingleton;
  }

  const db = buildSupabaseClient(url, key);
  const syncState = new SupabaseSyncStateStore(db);
  const journal = new Oplog(new SupabaseJournalStore(db));
  const target = new SupabaseSyncTarget(db, syncState);
  const writer = new SyncWriter({
    target,
    state: syncState,
  });

  const durableBackend = new SupabaseBackend(db);

  const bridge = new BridgeClient({
    baseUrl: env.BRIDGE_URL ?? '',
    token: env.BRIDGE_TOKEN ?? '',
    channelId: env.BRIDGE_CHANNEL_ID ?? '',
  });
  const sink = new TelegramSink(bridge, target);

  const engine = new FsEngine(
    new BatchBackend(new ColdBackend(durableBackend, sink), writer),
    journal,
  );
  const executor = new Executor(new BufferedExecStore(new SupabaseExecStore(db), writer));

  supabaseRuntime = {
    db,
    syncState,
    journal,
    writer,
    engine,
    executor,
    sessions: new SupabaseSessionStore(db),
    sink,
    target,
    durableBackend,
  };
  runtimeSingleton = {
    engine,
    sessions: supabaseRuntime.sessions,
    executor,
    sync: writer,
    environment: 'supabase',
    sink,
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
      const coldBridge = new BridgeClient({
        baseUrl: loadEnv().BRIDGE_URL ?? '',
        token: loadEnv().BRIDGE_TOKEN ?? '',
        channelId: loadEnv().BRIDGE_CHANNEL_ID ?? '',
      });
      const coldSink = new TelegramSink(coldBridge, new SupabaseSyncTarget(db, coldState));
      return {
        engine: new FsEngine(
          new BatchBackend(new ColdBackend(new SupabaseBackend(db), coldSink), coldWriter),
          new Oplog(new SupabaseJournalStore(db)),
        ),
        writer: coldWriter,
        executor: new Executor(new BufferedExecStore(new SupabaseExecStore(db), coldWriter)),
      };
    },
  };
}

export function coldSelftestFactory(): ColdSelftestFactory | null {
  getRuntime();
  const sup = supabaseRuntime;
  if (!sup) return null;
  const { db, sessions } = sup;
  const env = loadEnv();

  const coldState = new SupabaseSyncStateStore(db);
  const coldTarget = new SupabaseSyncTarget(db, coldState);
  const coldWriter = new SyncWriter({ target: coldTarget, state: coldState });
  const bridge =
    env.BRIDGE_URL && env.BRIDGE_TOKEN
      ? new BridgeClient({
          baseUrl: env.BRIDGE_URL,
          token: env.BRIDGE_TOKEN,
          channelId: env.BRIDGE_CHANNEL_ID ?? '',
        })
      : new MockBridge();
  const coldSink = new TelegramSink(bridge, coldTarget);
  const coldEngine = new FsEngine(
    new BatchBackend(new ColdBackend(new SupabaseBackend(db), coldSink), coldWriter),
    new Oplog(new SupabaseJournalStore(db)),
  );

  return {
    sessions,
    engine: coldEngine,
    sink: coldSink,
    target: coldTarget,
    writePath: async (sessionId, path, bytes) => {
      await coldEngine.write(sessionId, path, bytes);
      await coldWriter.flush();
    },
    coldRead: async (sessionId, path) => {
      const result = await coldEngine.read(sessionId, path);
      return result.content;
    },
    prunePath: async (sessionId, path) => {
      const { error } = await db
        .from('blocks')
        .update({ data: null })
        .eq('session_id', sessionId)
        .eq('path', path);
      if (error) throw new Error(`prune failed: ${error.message}`);
    },
  };
}

export function resetRuntime(): void {
  runtimeSingleton?.sync?.stop();
  runtimeSingleton = null;
  supabaseRuntime = null;
}
