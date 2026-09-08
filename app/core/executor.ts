import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Execution } from '@mycomputer/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

const ALLOWED_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'PAGER'] as const;

function sandboxedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

function clip(bytes: Uint8Array): { text: string; truncated: boolean } {
  const overflow = bytes.byteLength > MAX_CAPTURE_BYTES;
  const slice = overflow ? bytes.slice(0, MAX_CAPTURE_BYTES) : bytes;
  return { text: Buffer.from(slice).toString('utf8'), truncated: overflow };
}

export interface RunRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ExecStore {
  insert(sessionId: string, execution: Execution): Promise<Execution>;
  get(sessionId: string, execId: string): Promise<Execution | null>;
  list(sessionId: string, offset?: number, limit?: number): Promise<Execution[]>;
  removeSessionData(sessionId: string): Promise<void>;
}

export class MemoryExecStore implements ExecStore {
  private readonly rows = new Map<string, Execution>();
  private readonly seq = new Map<string, number>();
  private counter = 0;

  async insert(_sessionId: string, execution: Execution): Promise<Execution> {
    this.rows.set(execution.execId, execution);
    this.seq.set(execution.execId, this.counter++);
    return execution;
  }

  async get(sessionId: string, execId: string): Promise<Execution | null> {
    const row = this.rows.get(execId);
    return row && row.sessionId === sessionId ? row : null;
  }

  async list(sessionId: string, offset = 0, limit = 100): Promise<Execution[]> {
    return [...this.rows.values()]
      .filter((row) => row.sessionId === sessionId)
      .sort((a, b) => (this.seq.get(b.execId) ?? 0) - (this.seq.get(a.execId) ?? 0))
      .slice(offset, offset + limit);
  }

  async removeSessionData(sessionId: string): Promise<void> {
    for (const [key, row] of this.rows) {
      if (row.sessionId === sessionId) this.rows.delete(key);
    }
  }
}

interface ExecRowRaw {
  exec_id: string;
  session_id: string;
  command: string;
  cwd: string | null;
  stdout: string | null;
  stderr: string | null;
  exit_code: number | null;
  duration_ms: number;
  created_at: string;
}

function mapExecution(row: ExecRowRaw, truncated: boolean): Execution {
  return {
    execId: row.exec_id,
    sessionId: row.session_id,
    command: row.command,
    cwd: row.cwd,
    stdout: fromBytea(row.stdout),
    stderr: fromBytea(row.stderr),
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    timedOut: row.exit_code === null,
    truncated,
    createdAt: row.created_at,
  };
}

export class SupabaseExecStore implements ExecStore {
  constructor(private readonly db: SupabaseClient) {}

  async insert(sessionId: string, execution: Execution): Promise<Execution> {
    const { error } = await this.db.from('executions').insert({
      exec_id: execution.execId,
      session_id: sessionId,
      command: execution.command,
      cwd: execution.cwd,
      stdout: toBytea(execution.stdout),
      stderr: toBytea(execution.stderr),
      exit_code: execution.exitCode,
      duration_ms: execution.durationMs,
      created_at: execution.createdAt,
    });
    if (error) throw new Error(`executions insert failed: ${error.message}`);
    return execution;
  }

  async get(sessionId: string, execId: string): Promise<Execution | null> {
    const { data, error } = await this.db
      .from('executions')
      .select('*')
      .eq('session_id', sessionId)
      .eq('exec_id', execId)
      .maybeSingle();
    if (error) throw new Error(`executions select failed: ${error.message}`);
    return data ? mapExecution(data as ExecRowRaw, false) : null;
  }

  async list(sessionId: string, offset = 0, limit = 100): Promise<Execution[]> {
    const { data, error } = await this.db
      .from('executions')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw new Error(`executions list failed: ${error.message}`);
    return (data as ExecRowRaw[]).map((row) => mapExecution(row, false));
  }

  async removeSessionData(sessionId: string): Promise<void> {
    const { error } = await this.db.from('executions').delete().eq('session_id', sessionId);
    if (error) throw new Error(`executions cleanup failed: ${error.message}`);
  }
}

export class Executor {
  constructor(
    private readonly store: ExecStore,
    private readonly defaults: { timeoutMs?: number } = {},
  ) {}

  scratchDir(sessionId: string): string {
    return join(tmpdir(), `ws-${sessionId}`);
  }

  async get(sessionId: string, execId: string): Promise<Execution | null> {
    return this.store.get(sessionId, execId);
  }

  async list(sessionId: string, offset?: number, limit?: number): Promise<Execution[]> {
    return this.store.list(sessionId, offset, limit);
  }

  async removeSessionData(sessionId: string): Promise<void> {
    return this.store.removeSessionData(sessionId);
  }

  async run(sessionId: string, request: RunRequest): Promise<Execution> {
    const command = request.command.trim();
    if (!command) throw new Error('command must be a non-empty string');

    const scratch = this.scratchDir(sessionId);
    mkdirSync(scratch, { recursive: true });
    const cwd = request.cwd ? join(scratch, request.cwd) : scratch;
    mkdirSync(cwd, { recursive: true });

    const timeoutMs = Math.min(
      request.timeoutMs ?? this.defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );

    const started = Date.now();
    const execId = randomUUID();
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];

    const child = spawn('/bin/bash', ['-lc', command], {
      cwd,
      env: sandboxedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let timedOut = false;
    let truncated = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 5000).unref();
    }, timeoutMs);
    timer.unref();

    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_CAPTURE_BYTES) stdout.push(chunk);
      else truncated = true;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_CAPTURE_BYTES) stderr.push(chunk);
      else truncated = true;
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(-1));
      child.on('close', (code) => resolve(code));
    });
    clearTimeout(timer);

    const out = clip(new Uint8Array(Buffer.concat(stdout)));
    const err = clip(new Uint8Array(Buffer.concat(stderr)));
    const durationMs = Date.now() - started;

    const execution: Execution = {
      execId,
      sessionId,
      command,
      cwd,
      stdout: out.text,
      stderr: err.text,
      exitCode: timedOut ? null : exitCode,
      durationMs,
      timedOut,
      truncated: truncated || out.truncated || err.truncated,
      createdAt: new Date().toISOString(),
    };

    return this.store.insert(sessionId, execution);
  }
}

const toBytea = (value: string) => `\\x${Buffer.from(value).toString('hex')}`;
const fromBytea = (value: string | null): string => {
  if (!value) return '';
  if (value.startsWith('\\x')) return Buffer.from(value.slice(2), 'hex').toString('utf8');
  return Buffer.from(value, 'base64').toString('utf8');
};
