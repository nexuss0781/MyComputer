import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeMemoryEngine, runSelftest } from '../core/selftest.js';
import { createApp } from './app.js';
import { resetRuntime } from './runtime.js';
import { MemorySessionStore } from './session.js';

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
const fromB64 = (value: string) => Buffer.from(value, 'base64').toString('utf8');

describe('app routes', () => {
  beforeAll(() => {
    resetRuntime();
  });

  afterEach(() => {
    resetRuntime();
  });

  it('ping responds ok', async () => {
    const app = createApp();
    const res = await app.request('/api/sys/ping');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      service: 'my-computer',
      route: '/api/sys/ping',
    });
  });

  it('unknown routes return 404 JSON', async () => {
    const app = createApp();
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ ok: false, error: 'not_found' });
  });

  it('selftest passes on the memory engine', async () => {
    const result = await runSelftest(makeMemoryEngine(), 'memory', new MemorySessionStore());
    expect(result.ok).toBe(true);
    expect(result.failed).toBe(0);
    expect(result.total).toBeGreaterThan(0);
  });

  it('fs endpoints round-trip a full write/read/delete flow over http', async () => {
    const app = createApp();

    const created = await app.request('/api/sys/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'http-test' }),
    });
    expect(created.status).toBe(200);
    const session = ((await created.json()) as { data: { id: string } }).data;
    expect(session.id).toBeTruthy();

    const writeRes = await app.request('/api/fs/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.id,
        path: '/photos/sun.jpg',
        content: b64('sunshine'),
        mime: 'image/jpeg',
      }),
    });
    expect(writeRes.status).toBe(200);
    const written = ((await writeRes.json()) as { data: { checksum: string } }).data;
    expect(written.checksum).toBeTruthy();

    const checksumRes = await app.request('/api/fs/checksum', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, path: '/photos/sun.jpg' }),
    });
    expect(checksumRes.status).toBe(200);
    const checksum = ((await checksumRes.json()) as { data: { checksum: string } }).data;
    expect(checksum.checksum).toBe(written.checksum);

    const readRes = await app.request('/api/fs/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, path: '/photos/sun.jpg' }),
    });
    expect(readRes.status).toBe(200);
    const read = ((await readRes.json()) as { data: { content: string } }).data;
    expect(fromB64(read.content)).toBe('sunshine');

    const traversalRes = await app.request('/api/fs/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, path: '/../escape', content: '' }),
    });
    expect(traversalRes.status).toBe(400);
    await expect(traversalRes.json()).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_path', message: expect.any(String) },
    });

    const deleted = await app.request(`/api/sys/session/${session.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
  });
});
