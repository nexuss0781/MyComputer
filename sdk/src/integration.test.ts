import { createHash } from 'node:crypto';
import { NotFoundError } from '@nexuss0781/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app/src/app.js';
import { resetRuntime } from '../../app/src/runtime.js';
import { readAll, readText, writeAll } from './fssio.js';
import { ComputerClient } from './index.js';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('@nexuss0781/mycomputer integration (memory app runtime)', () => {
  let client: ComputerClient;
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(() => {
    resetRuntime();
    const app = createApp();
    client = new ComputerClient({
      baseUrl: 'http://mycomputer.local',
      fetchFn: (input, init) => app.request(String(input), init as RequestInit),
    });
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
    resetRuntime();
  });

  it('mounts a session and mirrors a full agent flow end-to-end', async () => {
    const session = await client.createSession({ name: 'sdk-e2e' });
    expect(session.id).toBeTruthy();

    const mounted = client.mount(session.id);
    expect(mounted.sessionId).toBe(session.id);

    // write → read back → checksum (base path)
    const writeRes = await mounted.write('/notes/agent.txt', 'phase 6', 'text/plain');
    expect(writeRes.size).toBe(7);
    const readRes = await mounted.read('/notes/agent.txt');
    expect(readRes.bytes).toBe(7);
    expect(readRes.content).toEqual(new Uint8Array(Buffer.from('phase 6', 'utf8')));
    expect(writeRes.checksum).toBe(sha256(Buffer.from('phase 6')));

    // append
    const appendRes = await mounted.append('/notes/agent.txt', '!');
    expect(appendRes.size).toBe(8);

    // list
    const entries = await mounted.list('/notes');
    expect(entries.some((e) => e.path === '/notes/agent.txt')).toBe(true);

    // stat + checksum
    const stat = await mounted.stat('/notes/agent.txt');
    expect(stat.size).toBe(8);
    const cksum = await mounted.checksum('/notes/agent.txt');
    expect(cksum.checksum).toBe(sha256(Buffer.from('phase 6!')));

    // exec → log replay
    const execution = await mounted.exec('node --version');
    expect(execution.exitCode).toBe(0);
    expect(execution.stdout.length).toBeGreaterThan(0);
    const replay = (await mounted.execLog({ execId: execution.execId })) as {
      execId: string;
      stdout: string;
      totalLines: number;
    };
    expect(replay.execId).toBe(execution.execId);
    expect(replay.stdout).toContain('v');

    // remove
    const removed = await mounted.remove('/notes', true);
    expect(removed.deleted).toContain('/notes/agent.txt');

    cleanup = async () => {
      await client.deleteSession(session.id);
    };
  });

  it('writeAll across chunk boundaries restores byte-identical via readAll', async () => {
    const session = await client.createSession({ name: 'sdk-chunks' });

    const content = Buffer.concat([
      Buffer.from('chunk-boundary:'),
      Buffer.alloc(10 * 1024 * 1024, 0x61), // 10 MiB 'aaaa'
      Buffer.from(':tail'),
    ]);
    const result = await writeAll(client, session.id, '/big.dat', content, {
      chunkSize: 8 * 1024 * 1024,
    });
    expect(result.size).toBe(content.length);
    expect(result.blocks).toBeGreaterThan(1);

    const restored = await readAll(client, session.id, '/big.dat');
    expect(restored.byteLength).toBe(content.length);
    expect(Buffer.from(restored).equals(content)).toBe(true);
    expect(sha256(restored)).toBe(result.checksum);

    cleanup = async () => {
      await client.deleteSession(session.id);
    };
  });

  it('surfaces not_found as NotFoundError when reading a missing file', async () => {
    const session = await client.createSession({ name: 'sdk-missing' });
    const mounted = client.mount(session.id);
    await expect(mounted.read('/does-not-exist')).rejects.toBeInstanceOf(NotFoundError);

    const text = await readText(client, session.id, '/missing.txt').catch(() => null);
    expect(text).toBeNull();

    cleanup = async () => {
      await client.deleteSession(session.id);
    };
  });

  it('selftest and session lifecycle work through the client', async () => {
    const result = await client.selftest();
    expect(result.ok).toBe(true);
    expect(result.total).toBeGreaterThan(0);
    expect(result.passed).toBe(result.total);
    expect(result.failed).toBe(0);

    const sessions = await client.listSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });
});
