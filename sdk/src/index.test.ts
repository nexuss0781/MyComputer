import { type ApiErrorShape, ConflictError, NotFoundError, PathError } from '@nexuss0781/shared';
import { describe, expect, it } from 'vitest';
import { SdkError, codec } from './http.js';
import { ComputerClient } from './index.js';

function mockFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown },
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

const client = (fetchFn: typeof fetch) =>
  new ComputerClient({ baseUrl: 'https://api.example.com', fetchFn });

describe('codec', () => {
  it('round-trips utf8 strings through base64', () => {
    const original = 'hello \u{1F980} world';
    const encoded = codec.toBase64(original);
    expect(codec.toText(codec.toBytes(encoded))).toBe(original);
  });

  it('round-trips binary bytes', () => {
    const bytes = new Uint8Array([0, 255, 10, 128]);
    const encoded = codec.toBase64(bytes);
    expect(Array.from(codec.toBytes(encoded))).toEqual([0, 255, 10, 128]);
  });

  it('matches what the app sends and returns', () => {
    const body = 'sunshine';
    const appSide = Buffer.from(body, 'utf8').toString('base64');
    expect(codec.toBase64(body)).toBe(appSide);
    expect(codec.toText(codec.toBytes(appSide))).toBe(body);
  });
});

describe('ComputerClient transport', () => {
  it('normalizes a trailing slash on the base URL', () => {
    const c = new ComputerClient({ baseUrl: 'https://api.example.com/' });
    expect(c.baseUrl).toBe('https://api.example.com');
  });

  it('posts fs/write with base64-encoded content and parses the envelope', async () => {
    let seenUrl = '';
    let seenBody = '';
    const fetchFn = mockFetch((url, init) => {
      seenUrl = url;
      seenBody = String(init?.body);
      return {
        status: 200,
        body: { ok: true, data: { path: '/a', size: 3, checksum: 'c', blocks: 1 } },
      };
    });
    const result = await client(fetchFn).write('sess', '/a', 'abc');
    expect(seenUrl).toBe('https://api.example.com/api/fs/write');
    expect((JSON.parse(seenBody) as { content: string }).content).toBe(codec.toBase64('abc'));
    expect(result).toEqual({ path: '/a', size: 3, checksum: 'c', blocks: 1 });
  });

  it('decodes read content back into bytes', async () => {
    const body = 'payload';
    const fetchFn = mockFetch(() => ({
      status: 200,
      body: {
        ok: true,
        data: { path: '/a', offset: 0, bytes: 7, checksum: null, content: codec.toBase64(body) },
      },
    }));
    const result = await client(fetchFn).read('sess', '/a');
    expect(codec.toText(result.content)).toBe(body);
  });

  it('maps not_found to NotFoundError', async () => {
    const fetchFn = mockFetch(() => ({
      status: 404,
      body: { ok: false, error: { code: 'not_found', message: 'missing' } },
    }));
    await expect(client(fetchFn).read('sess', '/nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('maps already_exists to ConflictError', async () => {
    const fetchFn = mockFetch(() => ({
      status: 409,
      body: { ok: false, error: { code: 'already_exists', message: 'exists' } },
    }));
    await expect(client(fetchFn).mkdir('sess', '/x')).rejects.toBeInstanceOf(ConflictError);
  });

  it('maps invalid_path to PathError', async () => {
    const fetchFn = mockFetch(() => ({
      status: 400,
      body: { ok: false, error: { code: 'invalid_path', message: 'bad path' } },
    }));
    await expect(client(fetchFn).read('sess', '/../x')).rejects.toBeInstanceOf(PathError);
  });

  it('maps unknown codes to SdkError with the response status', async () => {
    const fetchFn = mockFetch(() => ({
      status: 500,
      body: { ok: false, error: { code: 'internal', message: 'boom' } },
    }));
    const error = await client(fetchFn)
      .ping()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SdkError);
    expect((error as SdkError).status).toBe(500);
    expect((error as SdkError).code).toBe('internal');
  });

  it('surfaces non-2xx with an error envelope as a typed error', async () => {
    const fetchFn = mockFetch(() => ({
      status: 503,
      body: {
        ok: false,
        error: { code: 'engine_not_configured', message: 'fs engine not configured' },
      } satisfies ApiErrorShape,
    }));
    await expect(client(fetchFn).list('sess', '/')).rejects.toMatchObject({
      code: 'engine_not_configured',
      status: 503,
    });
  });
});
