import { describe, expect, it } from 'vitest';
import { ComputerClient } from './index.js';

describe('ComputerClient', () => {
  it('normalizes a trailing slash on the base URL', () => {
    const client = new ComputerClient({ baseUrl: 'https://api.example.com/' });
    expect(client.baseUrl).toBe('https://api.example.com');
  });

  it('pings and surfaces non-ok responses as errors', async () => {
    const client = new ComputerClient({ baseUrl: 'https://never-called.example' });
    const c = client as unknown as { ping: () => Promise<unknown> };
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ ok: false }), { status: 500 });
    }) as typeof fetch;

    await expect(c.ping()).rejects.toThrow('500');
  });
});
