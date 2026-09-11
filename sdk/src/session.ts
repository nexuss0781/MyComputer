import type { Execution, Inode } from '@nexuss0781/shared';
import type { ComputerClient } from './index.js';

export interface SessionFacade {
  readonly sessionId: string;
  readonly client: ComputerClient;
  write(path: string, content: Uint8Array | string, mime?: string): Promise<WriteOutput>;
  read(path: string, options?: ReadOptions): Promise<ReadOutput>;
  append(path: string, content: Uint8Array | string): Promise<WriteOutput>;
  mkdir(path: string, recursive?: boolean): Promise<MkdirOutput>;
  list(path: string): Promise<Inode[]>;
  move(from: string, to: string): Promise<MoveOutput>;
  copy(from: string, to: string): Promise<CopyOutput>;
  remove(path: string, recursive?: boolean): Promise<RemoveOutput>;
  stat(path: string): Promise<Inode>;
  checksum(path: string): Promise<ChecksumOutput>;
  exec(command: string, options?: ExecOptions): Promise<Execution>;
  execLog(options?: ExecLogOptions): Promise<ExecLogOutput>;
}

export interface WriteOutput {
  path: string;
  size: number;
  checksum: string;
  blocks: number;
}

export interface ReadOptions {
  offset?: number;
  limit?: number;
}

export interface ReadOutput {
  path: string;
  offset: number;
  bytes: number;
  checksum: string | null;
  content: Uint8Array;
}

export interface MkdirOutput {
  path: string;
}

export interface MoveOutput {
  from: string;
  to: string;
  moved?: number;
}

export interface CopyOutput {
  from: string;
  to: string;
  copied?: number;
}

export interface RemoveOutput {
  deleted: string[];
}

export interface ChecksumOutput {
  path: string;
  checksum: string;
}

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
}

export interface ExecLogOptions {
  execId?: string;
  offset?: number;
  limit?: number;
}

export interface ExecLogDetail extends Execution {
  totalLines: number;
}

export interface ExecLogList {
  total: number;
  offset: number;
  limit: number;
  executions: Execution[];
}

export type ExecLogOutput = ExecLogDetail | ExecLogList;

export interface FsyncOutput {
  ok: boolean;
  reconciled: number;
  flushed: number;
  failed: number;
  sink: {
    disabled: boolean;
    paths: number;
    chunks: number;
    manifests: number;
    durationMs: number;
  } | null;
}

export interface SelftestOutput {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  failures: { name?: string; error?: string }[];
  environment: string;
}

export function mountSession(client: ComputerClient, sessionId: string): SessionFacade {
  return {
    sessionId,
    client,
    write: (path, content, mime) => client.write(sessionId, path, content, mime),
    read: (path, options) => client.read(sessionId, path, options),
    append: (path, content) => client.append(sessionId, path, content),
    mkdir: (path, recursive) => client.mkdir(sessionId, path, recursive),
    list: (path) => client.list(sessionId, path),
    move: (from, to) => client.move(sessionId, from, to),
    copy: (from, to) => client.copy(sessionId, from, to),
    remove: (path, recursive) => client.remove(sessionId, path, recursive),
    stat: (path) => client.stat(sessionId, path),
    checksum: (path) => client.checksum(sessionId, path),
    exec: (command, options) => client.exec(sessionId, command, options),
    execLog: (options) => client.execLog(sessionId, options),
  };
}
