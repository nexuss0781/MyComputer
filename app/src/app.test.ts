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
    expect(result.total).toBe(18);
  }, 60000);

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

  it('tools endpoint lists declarations with the ethco contract', async () => {
    const app = createApp();
    const res = await app.request('/api/tools');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    };
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.tools.map((t) => t.name)).toContain('bash');
    for (const tool of body.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeTruthy();
    }
  });

  it('tools execute runs a bash-style command via run_command', async () => {
    const app = createApp();
    const res = await app.request('/api/tools/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'run_command', args: { command: 'echo hello-from-ethco' } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      result: { stdout: string; exitCode: number; success: boolean };
    };
    expect(body.success).toBe(true);
    expect(body.result.stdout).toContain('hello-from-ethco');
    expect(body.result.exitCode).toBe(0);
  });

  it('tools execute supports tool aliases (read -> view_file, write -> create_file, edit -> edit_file)', async () => {
    const app = createApp();
    const resCreate = await app.request('/api/tools/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'create_file',
        args: { path: 'notes/ethco.txt', content: 'first line\nsecond line' },
      }),
    });
    expect(resCreate.status).toBe(200);
    const created = (await resCreate.json()) as { result: { success: boolean; action: string } };
    expect(created.result.success).toBe(true);

    const resRead = await app.request('/api/tools/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'read', args: { filePath: '/notes/ethco.txt', limit: 1 } }),
    });
    const read = (await resRead.json()) as {
      result: { startLine: number; endLine: number; content: string };
    };
    expect(read.result.startLine).toBe(1);
    expect(read.result.endLine).toBe(1);
    expect(read.result.content).toContain('first line');

    const resEdit = await app.request('/api/tools/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'edit',
        args: { filePath: 'notes/ethco.txt', oldString: 'second line', newString: 'replaced line' },
      }),
    });
    const edited = (await resEdit.json()) as { result: { success: boolean; action: string } };
    expect(edited.result.success).toBe(true);

    const resReadBack = await app.request('/api/tools/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'read', args: { filePath: 'notes/ethco.txt' } }),
    });
    const readBack = (await resReadBack.json()) as { result: { content: string } };
    expect(readBack.result.content).toContain('replaced line');
  });

  it('tools execute rejects unknown tools with success=false', async () => {
    const app = createApp();
    const res = await app.request('/api/tools/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'not_a_real_tool', args: {} }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; result: { error: string } };
    expect(body.success).toBe(false);
    expect(body.result.error).toContain('not implemented');
  });

  it('exec run executes a command and log replays its output', async () => {
    const app = createApp();
    const created = await app.request('/api/sys/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'exec-test' }),
    });
    const session = ((await created.json()) as { data: { id: string } }).data;

    const runRes = await app.request('/api/exec/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, command: 'echo exec-http-ok' }),
    });
    expect(runRes.status).toBe(200);
    const run = (await runRes.json()) as {
      ok: boolean;
      data: { execId: string; exitCode: number; stdout: string; createdAt: string };
    };
    expect(run.ok).toBe(true);
    expect(run.data.exitCode).toBe(0);
    expect(run.data.stdout).toContain('exec-http-ok');
    expect(run.data.execId).toBeTruthy();

    const logRes = await app.request('/api/exec/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, execId: run.data.execId }),
    });
    expect(logRes.status).toBe(200);
    const log = (await logRes.json()) as { ok: boolean; data: { stdout: string } };
    expect(log.ok).toBe(true);
    expect(log.data.stdout).toContain('exec-http-ok');
  });

  it('exec log lists executions and rejects unknown exec ids', async () => {
    const app = createApp();
    const created = await app.request('/api/sys/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'exec-list-test' }),
    });
    const session = ((await created.json()) as { data: { id: string } }).data;

    await app.request('/api/exec/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, command: 'echo one' }),
    });
    await app.request('/api/exec/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, command: 'echo two' }),
    });

    const listRes = await app.request('/api/exec/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id }),
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      data: { total: number; executions: Array<{ command: string }> };
    };
    expect(list.data.total).toBe(2);
    expect(list.data.executions[0]?.command).toBe('echo two');

    const missingRes = await app.request('/api/exec/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, execId: crypto.randomUUID() }),
    });
    expect(missingRes.status).toBe(404);
  });

  it('run_command via tools persists an execution row', async () => {
    const app = createApp();
    const res = await app.request('/api/tools/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'run_command', args: { command: 'echo persisted-via-tools' } }),
    });
    expect(res.status).toBe(200);
    const toolResult = (await res.json()) as { success: boolean; result: { stdout: string } };
    expect(toolResult.success).toBe(true);
    expect(toolResult.result.stdout).toContain('persisted-via-tools');

    const sessionsRes = await app.request('/api/sys/session');
    const sessions = ((await sessionsRes.json()) as { data: Array<{ id: string; name: string }> })
      .data;
    const workspace = sessions.find((s) => s.name === 'ethco-workspace');
    if (!workspace) throw new Error('workspace session was not created');

    const listRes = await app.request('/api/exec/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: workspace.id }),
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      ok: boolean;
      data: { executions: Array<{ command: string; stdout: string }> };
    };
    expect(list.ok).toBe(true);
    const found = list.data.executions.find((e) => e.command === 'echo persisted-via-tools');
    expect(found).toBeTruthy();
  });
});
