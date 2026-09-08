import { ConflictError, NotFoundError, PathError } from '@mycomputer/shared';
import type { SessionStore } from '../src/session.js';
import { FsEngine } from './fs-engine.js';
import { MemoryBackend } from './memory-backend.js';
import { MemoryJournalStore, Oplog } from './oplog.js';

export type SelftestEnvironment = 'memory' | 'supabase';

export interface SelftestResult {
  ok: boolean;
  environment: SelftestEnvironment;
  total: number;
  passed: number;
  failed: number;
  failures: string[];
  durationMs: number;
  journalOps: number;
}

interface Suite {
  name: string;
  run(): Promise<void>;
}

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
const fromB64 = (value: string) => Buffer.from(value, 'base64').toString('utf8');
const bytes = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'));

function expectEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
}

async function expectError<T extends Error>(
  action: () => Promise<unknown>,
  ctor: new (...args: never[]) => T,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ctor) return;
    throw new Error(`wrong error type: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error('expected an error, but none was thrown');
}

function buildSuite(sessionId: string, engine: FsEngine): Suite[] {
  return [
    {
      name: 'path traversal rejects .. (invalid_path)',
      run: async () => {
        await expectError(
          () => engine.write(sessionId, '/../etc/passwd', new Uint8Array(0)),
          PathError,
        );
        await expectError(() => engine.read(sessionId, '/a/../../b'), PathError);
      },
    },
    {
      name: 'missing file stat returns 404',
      run: async () => {
        await expectError(() => engine.stat(sessionId, '/nope'), NotFoundError);
      },
    },
    {
      name: 'write auto-creates parent dirs',
      run: async () => {
        const result = await engine.write(
          sessionId,
          '/docs/notes/b.txt',
          bytes(b64('hello world')),
        );
        expectEqual(result.size, 11);
        await engine.stat(sessionId, '/docs');
        await engine.stat(sessionId, '/docs/notes');
        await engine.stat(sessionId, '/docs/notes/b.txt');
      },
    },
    {
      name: 'read returns byte-identical content',
      run: async () => {
        const content = bytes(b64('The quick brown fox jumps over the lazy dog.'.repeat(100)));
        await engine.write(sessionId, '/docs/fox.txt', content, 'text/plain');
        const read = await engine.read(sessionId, '/docs/fox.txt');
        expectEqual(Buffer.from(read.content, 'base64').equals(Buffer.from(content)), true);
      },
    },
    {
      name: 'multi-block file above 8MiB round-trips',
      run: async () => {
        const raw = new Uint8Array(10 * 1024 * 1024);
        for (let i = 0; i < raw.length; i++) raw[i] = i % 251;
        const result = await engine.write(sessionId, '/big.bin', raw);
        expectEqual(result.blocks, 2);
        const read = await engine.read(sessionId, '/big.bin');
        expectEqual(Buffer.from(read.content, 'base64').equals(Buffer.from(raw)), true);
      },
    },
    {
      name: 'append extends existing content',
      run: async () => {
        await engine.write(sessionId, '/log.txt', bytes(b64('one\n')));
        await engine.append(sessionId, '/log.txt', bytes(b64('two\n')));
        const read = await engine.read(sessionId, '/log.txt');
        expectEqual(fromB64(read.content), 'one\ntwo\n');
      },
    },
    {
      name: 'mkdir is idempotent when recursive, conflicts otherwise',
      run: async () => {
        await engine.mkdir(sessionId, '/a/b', true);
        await engine.mkdir(sessionId, '/a/b', true);
        await expectError(() => engine.mkdir(sessionId, '/a/b'), ConflictError);
        await expectError(() => engine.mkdir(sessionId, '/orphan/x'), NotFoundError);
      },
    },
    {
      name: 'list shows only direct children',
      run: async () => {
        const entries = await engine.list(sessionId, '/a');
        expectEqual(entries.length, 1);
        expectEqual(entries[0]?.path, '/a/b');
      },
    },
    {
      name: 'move renames subtree and keeps content',
      run: async () => {
        await engine.write(sessionId, '/a/f.txt', bytes(b64('payload')));
        await engine.move(sessionId, '/a', '/moved');
        await expectError(() => engine.stat(sessionId, '/a'), NotFoundError);
        const inMoved = await engine.read(sessionId, '/moved/f.txt');
        expectEqual(fromB64(inMoved.content), 'payload');
      },
    },
    {
      name: 'cannot move a directory into itself',
      run: async () => {
        await expectError(() => engine.move(sessionId, '/moved', '/moved/self'), PathError);
      },
    },
    {
      name: 'copy duplicates subtree with identical content',
      run: async () => {
        await engine.copy(sessionId, '/moved', '/clone');
        const original = await engine.checksum(sessionId, '/moved/f.txt');
        const duplicate = await engine.checksum(sessionId, '/clone/f.txt');
        expectEqual(duplicate.checksum, original.checksum);
      },
    },
    {
      name: 'delete non-empty dir conflicts unless recursive',
      run: async () => {
        await expectError(() => engine.remove(sessionId, '/clone'), ConflictError);
        const removed = await engine.remove(sessionId, '/clone', true);
        expectEqual(removed.deleted.includes('/clone/f.txt'), true);
        await expectError(() => engine.stat(sessionId, '/clone'), NotFoundError);
      },
    },
    {
      name: 'checksum matches written content',
      run: async () => {
        const written = await engine.write(sessionId, '/checksum.txt', bytes(b64('abc')));
        const got = await engine.checksum(sessionId, '/checksum.txt');
        expectEqual(got.checksum, written.checksum);
      },
    },
    {
      name: 'every mutating op is journaled',
      run: async () => {
        const before = await engine.oplog.journalCount(sessionId);
        await engine.write(sessionId, '/journals/n1.txt', bytes(b64('x')));
        await engine.mkdir(sessionId, '/journals/nested', true);
        await engine.append(sessionId, '/journals/n1.txt', bytes(b64('y')));
        await engine.move(sessionId, '/journals/n1.txt', '/journals/n2.txt');
        await engine.remove(sessionId, '/journals/n2.txt');
        const after = await engine.oplog.journalCount(sessionId);
        expectEqual(after - before, 5);
      },
    },
  ];
}

export async function runSelftest(
  engine: FsEngine,
  environment: SelftestEnvironment,
  sessions: SessionStore,
): Promise<SelftestResult> {
  const started = Date.now();
  const session = await sessions.create({ name: 'selftest' });
  const sessionId = session.id;

  await engine.sessionInit(sessionId);

  const suites = buildSuite(sessionId, engine);
  const failures: string[] = [];
  let passed = 0;

  for (const suite of suites) {
    try {
      await suite.run();
      passed++;
    } catch (error) {
      failures.push(`${suite.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    await engine.remove(sessionId, '/', true);
  } catch {
    /* best-effort cleanup */
  }
  await sessions.remove(sessionId).catch(() => {});

  return {
    ok: failures.length === 0,
    environment,
    total: suites.length,
    passed,
    failed: failures.length,
    failures,
    durationMs: Date.now() - started,
    journalOps: await engine.oplog.journalCount(sessionId),
  };
}

export function makeMemoryEngine(): FsEngine {
  return new FsEngine(new MemoryBackend(), new Oplog(new MemoryJournalStore()));
}
