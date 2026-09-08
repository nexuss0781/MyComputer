import { describe, expect, it } from 'vitest';
import { Executor, MemoryExecStore } from './executor.js';

const SESSION_ID = '6c5f46e5-2a62-4be1-9d31-9a3f0e1c5c21';
const executor = () => new Executor(new MemoryExecStore());

describe('executor', () => {
  it('captures stdout and reports exit code 0', async () => {
    const execution = await executor().run(SESSION_ID, { command: `echo hello-${Date.now()}` });
    expect(execution.exitCode).toBe(0);
    expect(execution.stdout).toContain('hello-');
    expect(execution.stderr).toBe('');
    expect(execution.timedOut).toBe(false);
    expect(execution.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runs compound commands through the shell', async () => {
    const execution = await executor().run(SESSION_ID, {
      command: 'echo "a b" | tr "a-b" "A-B"',
    });
    expect(execution.exitCode).toBe(0);
    expect(execution.stdout).toContain('A');
    expect(execution.stdout).toContain('B');
  });

  it('captures stderr and reports a non-zero exit code', async () => {
    const execution = await executor().run(SESSION_ID, { command: 'echo boom 1>&2; exit 7' });
    expect(execution.exitCode).toBe(7);
    expect(execution.stderr).toContain('boom');
  });

  it('times out and kills the process when exceeding the cap', async () => {
    const execution = await executor().run(SESSION_ID, { command: 'sleep 30', timeoutMs: 400 });
    expect(execution.timedOut).toBe(true);
    expect(execution.exitCode).toBeNull();
    expect(execution.durationMs).toBeLessThan(10000);
  });

  it('isolates the environment from agent secrets', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'super-secret';
    process.env.SUPABASE_URL = 'https://secret.example';
    const execution = await executor().run(SESSION_ID, {
      command: 'test -z "$SUPABASE_SERVICE_ROLE_KEY" && test -z "$SUPABASE_URL" && echo isolated',
    });
    expect(execution.exitCode).toBe(0);
    expect(execution.stdout).toContain('isolated');
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    process.env.SUPABASE_URL = '';
  });

  it('persists executions and replays them from the store', async () => {
    const instance = executor();
    const execution = await instance.run(SESSION_ID, { command: 'echo persisted' });
    const replayed = await instance.get(SESSION_ID, execution.execId);
    expect(replayed?.stdout).toContain('persisted');
    expect(replayed?.command).toBe('echo persisted');
  });

  it('lists executions newest first and scopes by session', async () => {
    const instance = executor();
    const other = 'b2c4b9e3-8c4a-4a3d-9f11-1c2d3e4f5a6b';
    await instance.run(SESSION_ID, { command: 'echo one' });
    await instance.run(SESSION_ID, { command: 'echo two' });
    await instance.run(other, { command: 'echo other' });
    const rows = await instance.list(SESSION_ID);
    expect(rows.length).toBe(2);
    expect(rows[0]?.command).toBe('echo two');
  });

  it('removes session execution data', async () => {
    const instance = executor();
    await instance.run(SESSION_ID, { command: 'echo cleanup' });
    await instance.removeSessionData(SESSION_ID);
    expect((await instance.list(SESSION_ID)).length).toBe(0);
  });
});
