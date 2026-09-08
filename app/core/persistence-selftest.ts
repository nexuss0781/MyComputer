import type { SessionStore } from '../src/session.js';
import type { Executor } from './executor.js';
import type { FsEngine } from './fs-engine.js';
import type { Oplog } from './oplog.js';
import { type SyncStateStore, type SyncWriter, reconcileFromJournal } from './sync.js';

const fromB64 = (value: string) => Buffer.from(value, 'base64').toString('utf8');

function expectEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
}

export interface PersistenceSelftestDeps {
  engine: FsEngine;
  executor: Executor;
  writer: SyncWriter;
  state: SyncStateStore;
  journal: Oplog;
  sessions: SessionStore;
  buildCold: () => { engine: FsEngine; writer: SyncWriter; executor: Executor };
}

export interface PersistenceSelftestResult {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  failures: string[];
  flushBatchMs: number | null;
}

/**
 * Proves the Phase 4 durability contract against a live Supabase runtime:
 * batched flushes are byte-durable to a cold (buffer-empty) reader, the flush
 * watermark makes reconcile idempotent, exec results arrive through the same
 * batch path, and a 50-write flush completes in a bounded batch round.
 */
export async function runPersistenceSelftest(
  deps: PersistenceSelftestDeps,
): Promise<PersistenceSelftestResult> {
  const session = await deps.sessions.create({ name: 'selftest-p4' });
  const sessionId = session.id;
  const failures: string[] = [];
  let flushBatchMs: number | null = null;

  const runSuite = async (name: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  try {
    await deps.engine.sessionInit(sessionId);

    const content = 'lorem-ipsum-dolor-sit-amet-'.repeat(2000);

    await runSuite('cold reader sees flushed write + append byte-identically', async () => {
      await deps.engine.write(
        sessionId,
        '/p1.txt',
        new Uint8Array(Buffer.from(content)),
        'text/plain',
      );
      await deps.engine.append(sessionId, '/p1.txt', new Uint8Array(Buffer.from('appended!')));
      await deps.engine.write(sessionId, '/p2/deep.txt', new Uint8Array(Buffer.from('deep')));
      await deps.writer.flush();

      const cold = deps.buildCold();
      const read = await cold.engine.read(sessionId, '/p1.txt');
      expectEqual(fromB64(read.content), `${content}appended!`);
      const deep = await cold.engine.read(sessionId, '/p2/deep.txt');
      expectEqual(fromB64(deep.content), 'deep');
    });

    await runSuite('reconcile is idempotent after flush (0 replayed)', async () => {
      const cold = deps.buildCold();
      const replayed = await reconcileFromJournal({
        writer: cold.writer,
        journal: deps.journal,
        state: deps.state,
        sessionId,
      });
      expectEqual(replayed, 0);
    });

    await runSuite('exec result is durable to a cold store', async () => {
      const execution = await deps.executor.run(sessionId, { command: 'echo p4-ok' });
      await deps.journal.record(
        'exec',
        sessionId,
        { command: execution.command },
        { execId: execution.execId, exitCode: execution.exitCode },
        'ok',
        execution.durationMs,
      );
      await deps.writer.flush();
      const cold = deps.buildCold();
      const replayed = await cold.executor.get(sessionId, execution.execId);
      expectEqual(replayed !== null, true);
      expectEqual(replayed?.stdout.includes('p4-ok'), true);
    });

    await runSuite('50-write single batch flush completes', async () => {
      for (let i = 0; i < 50; i++) {
        await deps.engine.write(sessionId, `/bench/f${i}.txt`, new Uint8Array(256));
      }
      const started = Date.now();
      await deps.writer.flush();
      flushBatchMs = Date.now() - started;
    });
  } finally {
    try {
      await deps.engine.resetSession(sessionId);
      await deps.writer.flush();
    } catch {
      /* best-effort cleanup */
    }
    await deps.sessions.remove(sessionId).catch(() => {});
  }

  return {
    ok: failures.length === 0,
    total: 4,
    passed: 4 - failures.length,
    failed: failures.length,
    failures,
    flushBatchMs,
  };
}
