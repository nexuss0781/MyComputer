import type { Inode, WriteResult } from '@nexuss0781/shared';
import { describe, expect, it } from 'vitest';
import { ComputerClient, VirtualFs, codec } from './index.js';

function mockFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown },
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

const mkClient = (fetchFn: typeof fetch) =>
  new ComputerClient({ baseUrl: 'https://api.example.com', fetchFn });

// ── helpers ─────────────────────────────────────────────────────────

function mkInode(path: string, type: 'file' | 'dir', size = 0): Inode {
  return {
    path,
    sessionId: 'test',
    type,
    mode: 0o644,
    size,
    mime: null,
    checksum: null,
    parent: '/',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function mkWriteResult(path: string, size: number, checksum: string): WriteResult {
  return { path, size, checksum, blocks: 1 };
}

// ── unit tests ──────────────────────────────────────────────────────

describe('VirtualFs', () => {
  describe('readFile', () => {
    it('returns a Buffer from the remote content', async () => {
      const data = new TextEncoder().encode('hello fsa');
      const fetchFn = mockFetch((url, init) => {
        const body = JSON.parse(String(init?.body) || '{}') as Record<string, unknown>;
        if (String(url).includes('/api/fs/stat')) {
          return {
            status: 200,
            body: { ok: true, data: mkInode('/file.txt', 'file', data.byteLength) },
          };
        }
        if (String(url).includes('/api/fs/read')) {
          return {
            status: 200,
            body: {
              ok: true,
              data: {
                path: body.path,
                offset: 0,
                bytes: data.byteLength,
                checksum: null,
                content: codec.toBase64(data),
              },
            },
          };
        }
        return { status: 200, body: { ok: true, data: {} } };
      });

      const fsa = new VirtualFs(mkClient(fetchFn), 'sess');
      const buf = await fsa.readFile('/file.txt');
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.toString()).toBe('hello fsa');
    });
  });

  describe('writeFile', () => {
    it('calls write and invalidates cache', async () => {
      let wrotePath = '';
      let wroteBody = '';
      const fetchFn = mockFetch((url, init) => {
        if (String(url).includes('/api/fs/write')) {
          wrotePath = String(JSON.parse(String(init?.body) || '{}').path);
          wroteBody = String(init?.body);
          return { status: 200, body: { ok: true, data: mkWriteResult('/out.txt', 5, 'abc') } };
        }
        return { status: 200, body: { ok: true, data: {} } };
      });

      const fsa = new VirtualFs(mkClient(fetchFn), 'sess');
      await fsa.writeFile('/out.txt', 'world');
      expect(wrotePath).toBe('/out.txt');
      expect(JSON.parse(wroteBody).content).toBe(codec.toBase64('world'));
    });
  });

  describe('appendFile', () => {
    it('calls append', async () => {
      let appendedBody = '';
      const fetchFn = mockFetch((url, init) => {
        if (String(url).includes('/api/fs/append')) {
          appendedBody = String(init?.body);
          return { status: 200, body: { ok: true, data: mkWriteResult('/app.txt', 3, 'xyz') } };
        }
        return { status: 200, body: { ok: true, data: {} } };
      });

      const fsa = new VirtualFs(mkClient(fetchFn), 'sess');
      await fsa.appendFile('/app.txt', 'end');
      expect(JSON.parse(appendedBody).content).toBe(codec.toBase64('end'));
    });
  });

  describe('stat', () => {
    it('returns a Stat-like object', async () => {
      const fetchFn = mockFetch(() => ({
        status: 200,
        body: { ok: true, data: mkInode('/f.txt', 'file', 42) },
      }));
      const fsa = new VirtualFs(mkClient(fetchFn), 'sess');
      const st = await fsa.stat('/f.txt');
      expect(st.size).toBe(42);
      expect(st.isFile()).toBe(true);
      expect(st.isDirectory()).toBe(false);
      expect(st.mtime).toBeInstanceOf(Date);
    });

    it('returns from cache on second call (no HTTP)', async () => {
      let callCount = 0;
      const fetchFn = mockFetch((url) => {
        if (String(url).includes('/api/fs/stat')) callCount++;
        return { status: 200, body: { ok: true, data: mkInode('/cached.txt', 'file', 1) } };
      });
      const fsa = new VirtualFs(mkClient(fetchFn), 'sess');
      await fsa.stat('/cached.txt');
      await fsa.stat('/cached.txt');
      expect(callCount).toBe(1);
    });
  });

  describe('readdir', () => {
    it('returns string array by default', async () => {
      const fetchFn = mockFetch(() => ({
        status: 200,
        body: {
          ok: true,
          data: [mkInode('/d/a.txt', 'file'), mkInode('/d/sub', 'dir')],
        },
      }));
      const fsa = new VirtualFs(mkClient(fetchFn), 'sess');
      const names = await fsa.readdir('/d');
      expect(names).toEqual(['a.txt', 'sub']);
    });

    it('returns Dirent array with withFileTypes', async () => {
      const fetchFn = mockFetch(() => ({
        status: 200,
        body: {
          ok: true,
          data: [mkInode('/d/a.txt', 'file'), mkInode('/d/sub', 'dir')],
        },
      }));
      const fsa = new VirtualFs(mkClient(fetchFn), 'sess');
      const dents = (await fsa.readdir('/d', { withFileTypes: true })) as Array<{
        name: string;
        isFile: () => boolean;
        isDirectory: () => boolean;
      }>;
      expect(dents).toHaveLength(2);
      expect(dents[0]?.name).toBe('a.txt');
      expect(dents[0]?.isFile()).toBe(true);
      expect(dents[1]?.name).toBe('sub');
      expect(dents[1]?.isDirectory()).toBe(true);
    });

    it('caches on second call', async () => {
      let callCount = 0;
      const fetchFn = mockFetch((url) => {
        if (String(url).includes('/api/fs/list')) callCount++;
        return { status: 200, body: { ok: true, data: [] } };
      });
      const fsa = new VirtualFs(mkClient(fetchFn), 'sess');
      await fsa.readdir('/empty');
      await fsa.readdir('/empty');
      expect(callCount).toBe(1);
    });
  });

  describe('mkdir', () => {
    it('calls mkdir and clears dir cache', async () => {
      let mkdirPath = '';
      const fetchFn = mockFetch((url, init) => {
        if (String(url).includes('/api/fs/mkdir')) {
          mkdirPath = JSON.parse(String(init?.body) || '{}').path as string;
          return { status: 200, body: { ok: true, data: { path: mkdirPath } } };
        }
        return { status: 200, body: { ok: true, data: [] } };
      });
      const fsa = new VirtualFs(mkClient(fetchFn), 'sess');
      const result = await fsa.mkdir('/newdir', { recursive: true });
      expect(mkdirPath).toBe('/newdir');
      expect(result).toBe('/newdir');
    });
  });

  describe('rename', () => {
    it('calls move', async () => {
      let moveFrom = '';
      let moveTo = '';
      const fetchFn = mockFetch((url, init) => {
        if (String(url).includes('/api/fs/move')) {
          const body = JSON.parse(String(init?.body) || '{}');
          moveFrom = body.from;
          moveTo = body.to;
          return { status: 200, body: { ok: true, data: { from: moveFrom, to: moveTo } } };
        }
        return { status: 200, body: { ok: true, data: {} } };
      });
      const fsa = new VirtualFs(mkClient(fetchFn), 'sess');
      await fsa.rename('/old', '/new');
      expect(moveFrom).toBe('/old');
      expect(moveTo).toBe('/new');
    });
  });

  describe('copyFile', () => {
    it('calls copy', async () => {
      let copySrc = '';
      let copyDest = '';
      const fetchFn = mockFetch((url, init) => {
        if (String(url).includes('/api/fs/copy')) {
          const body = JSON.parse(String(init?.body) || '{}');
          copySrc = body.from;
          copyDest = body.to;
          return { status: 200, body: { ok: true, data: { from: copySrc, to: copyDest } } };
        }
        return { status: 200, body: { ok: true, data: {} } };
      });
      const fsa = new VirtualFs(mkClient(fetchFn), 'sess');
      await fsa.copyFile('/src', '/dst');
      expect(copySrc).toBe('/src');
      expect(copyDest).toBe('/dst');
    });
  });

  describe('rm', () => {
    it('calls delete with recursive flag', async () => {
      let deletedPath = '';
      let deletedRecursive = false;
      const fetchFn = mockFetch((url, init) => {
        if (String(url).includes('/api/fs/delete')) {
          const body = JSON.parse(String(init?.body) || '{}');
          deletedPath = body.path;
          deletedRecursive = body.recursive;
          return { status: 200, body: { ok: true, data: { deleted: [deletedPath] } } };
        }
        return { status: 200, body: { ok: true, data: {} } };
      });
      const fsa = new VirtualFs(mkClient(fetchFn), 'sess');
      await fsa.rm('/trash', { recursive: true });
      expect(deletedPath).toBe('/trash');
      expect(deletedRecursive).toBe(true);
    });
  });

  describe('FileHandle', () => {
    it('read/write/close lifecycle', async () => {
      const fetchFn = mockFetch((url, _init) => {
        if (String(url).includes('/api/fs/stat')) {
          return { status: 200, body: { ok: true, data: mkInode('/fh.txt', 'file', 5) } };
        }
        if (String(url).includes('/api/fs/read')) {
          return {
            status: 200,
            body: {
              ok: true,
              data: {
                path: '/fh.txt',
                offset: 0,
                bytes: 5,
                checksum: null,
                content: codec.toBase64('abcde'),
              },
            },
          };
        }
        if (String(url).includes('/api/fs/write')) {
          return { status: 200, body: { ok: true, data: mkWriteResult('/fh.txt', 3, 'xyz') } };
        }
        return { status: 200, body: { ok: true, data: {} } };
      });

      const fsa = new VirtualFs(mkClient(fetchFn), 'sess');
      const fh = await fsa.open('/fh.txt');
      expect(fh.closed).toBe(false);

      const buf = new Uint8Array(5);
      const readResult = await fh.read(buf, 0, 5, 0);
      expect(readResult.bytesRead).toBe(5);
      expect(Buffer.from(readResult.buffer).toString()).toBe('abcde');

      const writeResult = await fh.write(new Uint8Array([1, 2, 3]));
      expect(writeResult.bytesWritten).toBe(3);

      await fh.close();
      expect(fh.closed).toBe(true);

      await expect(fh.read(buf)).rejects.toThrow('FileHandle is closed');
    });
  });

  describe('createReadStream', () => {
    it('streams pages from the remote file', async () => {
      const fetchFn = mockFetch((url, init) => {
        if (String(url).includes('/api/fs/read')) {
          const body = JSON.parse(String(init?.body) || '{}') as { offset: number; limit: number };
          const full = 'abcdefghij';
          const offset = (body.offset as number) || 0;
          const limit = (body.limit as number) || full.length;
          const slice = full.slice(offset, offset + limit);
          return {
            status: 200,
            body: {
              ok: true,
              data: {
                path: '/stream.txt',
                offset,
                bytes: slice.length,
                checksum: null,
                content: codec.toBase64(slice),
              },
            },
          };
        }
        if (String(url).includes('/api/fs/stat')) {
          return { status: 200, body: { ok: true, data: mkInode('/stream.txt', 'file', 10) } };
        }
        return { status: 200, body: { ok: true, data: {} } };
      });

      const fsa = new VirtualFs(mkClient(fetchFn), 'sess');
      const chunks: Buffer[] = [];
      for await (const chunk of fsa.createReadStream('/stream.txt')) {
        chunks.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString()).toBe('abcdefghij');
    });
  });

  describe('createWriteStream', () => {
    it('collects chunks and writes via writeAll', async () => {
      let wroteContent = '';
      const fetchFn = mockFetch((url, init) => {
        if (String(url).includes('/api/fs/write')) {
          const body = JSON.parse(String(init?.body) || '{}');
          wroteContent = new TextDecoder().decode(codec.toBytes(body.content as string));
          return {
            status: 200,
            body: { ok: true, data: mkWriteResult('/w.txt', wroteContent.length, 'abc') },
          };
        }
        return { status: 200, body: { ok: true, data: {} } };
      });

      const fsa = new VirtualFs(mkClient(fetchFn), 'sess');
      const ws = fsa.createWriteStream('/w.txt');
      ws.write('hello ');
      ws.write('fsa');
      await new Promise<void>((res) => ws.end(() => res()));
      expect(wroteContent).toBe('hello fsa');
    });
  });
});
