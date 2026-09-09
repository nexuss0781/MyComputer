import { describe, expect, it, vi } from 'vitest';
import { BridgeClient } from './bridge-client.js';

function mockFetch(handler: (url: string, init: RequestInit) => unknown) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url instanceof Request ? url.url : String(url);
    const body = handler(urlStr, init ?? { method: 'GET' });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

const CLIENT = new BridgeClient({
  baseUrl: 'https://bridge.example.com',
  token: 'test-token',
  channelId: '-1001234567890',
});

describe('BridgeClient', () => {
  it('upload returns msgId and fileId from sendDocument', async () => {
    const fetchFn = mockFetch((url, init) => {
      expect(url).toContain('/bottest-token/sendDocument');
      expect(init.method).toBe('POST');
      return {
        ok: true,
        result: {
          message_id: 42,
          document: {
            file_id: 'FILE_ABC',
            file_unique_id: 'uniq',
            file_size: 5,
            file_path: 'docs/0.bin',
          },
          caption: '{}',
        },
      };
    });
    const client = new BridgeClient({
      baseUrl: 'https://bridge.example.com',
      token: 'test-token',
      channelId: '-1001234567890',
      fetchFn,
    });
    const result = await client.upload(new Uint8Array([1, 2, 3, 4, 5]), {
      sessionId: '00000000-0000-0000-0000-000000000001',
      path: '/test.bin',
      seq: 0,
      checksum: 'abc123',
      size: 5,
    });
    expect(result).toEqual({ msgId: 42, fileId: 'FILE_ABC' });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('upload retries on 500 then succeeds', async () => {
    let calls = 0;
    const fetchFn = mockFetch(() => {
      calls++;
      if (calls === 1) return { ok: false, error_code: 500, description: 'internal error' };
      return {
        ok: true,
        result: {
          message_id: 99,
          document: { file_id: 'FILE_OK', file_unique_id: 'u', file_size: 1, file_path: 'f/0.bin' },
        },
      };
    });
    const client = new BridgeClient({
      baseUrl: 'https://bridge.example.com',
      token: 't',
      channelId: '-100',
      fetchFn,
    });
    const r = await client.upload(new Uint8Array([1]), {
      sessionId: '00000000-0000-0000-0000-000000000001',
      path: '/a',
      seq: 0,
      checksum: 'x',
      size: 1,
    });
    expect(r).toEqual({ msgId: 99, fileId: 'FILE_OK' });
    expect(calls).toBe(2);
  });

  it('upload throws immediately on 400', async () => {
    const fetchFn = mockFetch(() => ({ ok: false, error_code: 400, description: 'bad request' }));
    const client = new BridgeClient({
      baseUrl: 'https://bridge.example.com',
      token: 't',
      channelId: '-100',
      fetchFn,
    });
    await expect(
      client.upload(new Uint8Array([1]), {
        sessionId: '00000000-0000-0000-0000-000000000001',
        path: '/a',
        seq: 0,
        checksum: 'x',
        size: 1,
      }),
    ).rejects.toThrow('telegram 400');
  });

  it('download fetches file then downloads raw bytes with checksum', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/getFile')) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { file_id: 'F1', file_unique_id: 'u', file_size: 3, file_path: 'docs/0.bin' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      expect(urlStr).toContain('/file/bottest-token/docs/0.bin');
      return new Response(new Uint8Array([10, 20, 30]), { status: 200 });
    });
    const client = new BridgeClient({
      baseUrl: 'https://bridge.example.com',
      token: 'test-token',
      channelId: '-100',
      fetchFn,
    });
    const result = await client.download('F1');
    expect(result.bytes).toEqual(new Uint8Array([10, 20, 30]));
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('available returns false when config incomplete', () => {
    expect(new BridgeClient({ baseUrl: '', token: '', channelId: '' }).available()).toBe(false);
    expect(CLIENT.available()).toBe(true);
  });
});
