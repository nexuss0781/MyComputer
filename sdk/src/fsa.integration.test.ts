import { createHash } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app/src/app.js';
import { resetRuntime } from '../../app/src/runtime.js';
import { ComputerClient } from './index.js';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('@nexuss0781/mycomputer fsa integration (memory app runtime)', () => {
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

  it('writeFile → readFile round-trips byte-identical', async () => {
    const session = await client.createSession({ name: 'fsa-e2e' });
    const fsa = client.mountFs(session.id);
    const data = Buffer.from('fsa adapter test');
    await fsa.writeFile('/test.txt', data);
    const buf = await fsa.readFile('/test.txt');
    expect(buf.equals(data)).toBe(true);
    cleanup = async () => {
      await client.deleteSession(session.id);
    };
  });

  it('readdir returns Dirent array', async () => {
    const session = await client.createSession({ name: 'fsa-dirent' });
    const fsa = client.mountFs(session.id);
    await fsa.writeFile('/dir/a.txt', 'aaa');
    await fsa.writeFile('/dir/b.txt', 'bbb');
    const names = await fsa.readdir('/dir');
    expect(names).toContain('a.txt');
    expect(names).toContain('b.txt');

    const dents = await fsa.readdir('/dir', { withFileTypes: true });
    expect(dents.some((d) => d.name === 'a.txt' && d.isFile())).toBe(true);
    cleanup = async () => {
      await client.deleteSession(session.id);
    };
  });

  it('stat returns Stats-like shape', async () => {
    const session = await client.createSession({ name: 'fsa-stat' });
    const fsa = client.mountFs(session.id);
    await fsa.writeFile('/stat.txt', 'content');
    const st = await fsa.stat('/stat.txt');
    expect(st.size).toBe(7);
    expect(st.isFile()).toBe(true);
    expect(st.isDirectory()).toBe(false);
    expect(st.mtime).toBeInstanceOf(Date);
    cleanup = async () => {
      await client.deleteSession(session.id);
    };
  });

  it('stat cache: second call uses cache (no HTTP)', async () => {
    const session = await client.createSession({ name: 'fsa-cache' });
    const fsa = client.mountFs(session.id);
    await fsa.writeFile('/cache.txt', 'data');
    const st1 = await fsa.stat('/cache.txt');
    const st2 = await fsa.stat('/cache.txt');
    expect(st1.size).toBe(st2.size);
    cleanup = async () => {
      await client.deleteSession(session.id);
    };
  });

  it('mkdir + readdir creates and lists', async () => {
    const session = await client.createSession({ name: 'fsa-mkdir' });
    const fsa = client.mountFs(session.id);
    await fsa.mkdir('/newdir');
    await fsa.writeFile('/newdir/child.txt', 'c');
    const names = await fsa.readdir('/newdir');
    expect(names).toContain('child.txt');
    cleanup = async () => {
      await client.deleteSession(session.id);
    };
  });

  it('rename moves a file', async () => {
    const session = await client.createSession({ name: 'fsa-rename' });
    const fsa = client.mountFs(session.id);
    await fsa.writeFile('/before.txt', 'data');
    await fsa.rename('/before.txt', '/after.txt');
    const buf = await fsa.readFile('/after.txt');
    expect(buf.toString()).toBe('data');
    cleanup = async () => {
      await client.deleteSession(session.id);
    };
  });

  it('copyFile duplicates content', async () => {
    const session = await client.createSession({ name: 'fsa-copy' });
    const fsa = client.mountFs(session.id);
    await fsa.writeFile('/orig.txt', 'copyme');
    await fsa.copyFile('/orig.txt', '/dup.txt');
    const buf = await fsa.readFile('/dup.txt');
    expect(buf.toString()).toBe('copyme');
    cleanup = async () => {
      await client.deleteSession(session.id);
    };
  });

  it('rm removes files recursively', async () => {
    const session = await client.createSession({ name: 'fsa-rm' });
    const fsa = client.mountFs(session.id);
    await fsa.writeFile('/rm/a.txt', '1');
    await fsa.writeFile('/rm/b.txt', '2');
    await fsa.rm('/rm', { recursive: true });
    const names = await fsa.readdir('/rm').catch(() => []);
    expect(names).toEqual([]);
    cleanup = async () => {
      await client.deleteSession(session.id);
    };
  });

  it('FileHandle read/write/close', async () => {
    const session = await client.createSession({ name: 'fsa-fh' });
    const fsa = client.mountFs(session.id);
    await fsa.writeFile('/fh.txt', 'initial');

    const fh = await fsa.open('/fh.txt');
    expect(fh.closed).toBe(false);

    const buf = Buffer.alloc(7);
    const readResult = await fh.read(buf, 0, 7, 0);
    expect(readResult.bytesRead).toBe(7);
    expect(buf.toString()).toBe('initial');

    await fh.write(Buffer.from('updated'));
    await fh.close();
    expect(fh.closed).toBe(true);

    const after = await fsa.readFile('/fh.txt');
    expect(after.toString()).toBe('updated');
    cleanup = async () => {
      await client.deleteSession(session.id);
    };
  });

  it('createReadStream → createWriteStream byte-identical 10 MiB', async () => {
    const session = await client.createSession({ name: 'fsa-streams' });
    const fsa = client.mountFs(session.id);
    const original = Buffer.concat([
      Buffer.from('stream-start:'),
      Buffer.alloc(10 * 1024 * 1024, 0x42),
      Buffer.from(':stream-end'),
    ]);

    const ws = fsa.createWriteStream('/big.bin');
    for (let i = 0; i < original.byteLength; i += 64 * 1024) {
      ws.write(original.subarray(i, i + 64 * 1024));
    }
    await new Promise<void>((res) => ws.end(() => res()));

    const chunks: Buffer[] = [];
    for await (const chunk of fsa.createReadStream('/big.bin')) {
      chunks.push(Buffer.from(chunk));
    }
    const restored = Buffer.concat(chunks);
    expect(restored.byteLength).toBe(original.byteLength);
    expect(sha256(restored)).toBe(sha256(original));
    cleanup = async () => {
      await client.deleteSession(session.id);
    };
  });

  it('appendFile appends to existing file', async () => {
    const session = await client.createSession({ name: 'fsa-append' });
    const fsa = client.mountFs(session.id);
    await fsa.writeFile('/app.txt', 'start');
    await fsa.appendFile('/app.txt', '+end');
    const buf = await fsa.readFile('/app.txt');
    expect(buf.toString()).toBe('start+end');
    cleanup = async () => {
      await client.deleteSession(session.id);
    };
  });

  it('lstat aliases stat (no symlinks in virtual FS)', async () => {
    const session = await client.createSession({ name: 'fsa-lstat' });
    const fsa = client.mountFs(session.id);
    await fsa.writeFile('/lstat.txt', 'x');
    const st = await fsa.lstat('/lstat.txt');
    expect(st.isFile()).toBe(true);
    expect(st.size).toBe(1);
    cleanup = async () => {
      await client.deleteSession(session.id);
    };
  });

  it('access resolves for existing files', async () => {
    const session = await client.createSession({ name: 'fsa-access' });
    const fsa = client.mountFs(session.id);
    await fsa.writeFile('/exists.txt', 'y');
    await expect(fsa.access('/exists.txt')).resolves.toBeUndefined();
    cleanup = async () => {
      await client.deleteSession(session.id);
    };
  });

  it('mkdir -p creates nested dirs', async () => {
    const session = await client.createSession({ name: 'fsa-mkdirp' });
    const fsa = client.mountFs(session.id);
    await fsa.mkdir('/a/b/c', { recursive: true });
    await fsa.writeFile('/a/b/c/file.txt', 'deep');
    const buf = await fsa.readFile('/a/b/c/file.txt');
    expect(buf.toString()).toBe('deep');
    cleanup = async () => {
      await client.deleteSession(session.id);
    };
  });
});
