import type { Execution, Inode, SessionRow, WriteResult } from '@mycomputer/shared';
import { HttpTransport, codec } from './http.js';
import type {
  ChecksumOutput,
  CopyOutput,
  ExecLogOptions,
  ExecLogOutput,
  ExecOptions,
  FsyncOutput,
  MkdirOutput,
  MoveOutput,
  ReadOptions,
  ReadOutput,
  RemoveOutput,
  SelftestOutput,
} from './session.js';
import { type SessionFacade, mountSession } from './session.js';

export interface ComputerClientConfig {
  baseUrl: string;
  fetchFn?: typeof fetch;
  /**
   * Maximum payload size for chunked write helpers (bytes, default 3 MiB).
   * Vercel's serverless HTTP body cap is ~4.5 MiB and base64 inflates payloads
   * 4/3, so chunking is required on prod; 3 MiB raw → 4 MiB wire is proven safe
   * (probes blocked at 4.375 MiB wire).
   */
  chunkSize?: number;
}

export class ComputerClient {
  readonly baseUrl: string;
  readonly chunkSize: number;
  private readonly http: HttpTransport;

  constructor(config: ComputerClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.chunkSize = config.chunkSize ?? 3 * 1024 * 1024;
    this.http = new HttpTransport(this.baseUrl, { fetchFn: config.fetchFn });
  }

  async ping(): Promise<{ ok: boolean; service: string; route: string }> {
    return this.http.getRaw('/api/sys/ping');
  }

  // ── sessions ─────────────────────────────────────────────────────

  async createSession(
    input: { name?: string; meta?: Record<string, unknown> } = {},
  ): Promise<SessionRow> {
    return this.http.post('/api/sys/session', input);
  }

  async listSessions(): Promise<SessionRow[]> {
    return this.http.get('/api/sys/session');
  }

  async deleteSession(id: string): Promise<{ deleted: string; journalPreserved: boolean }> {
    return this.http.delete(`/api/sys/session/${id}`);
  }

  mount(sessionId: string): SessionFacade {
    return mountSession(this, sessionId);
  }

  // ── fs ───────────────────────────────────────────────────────────

  async write(
    sessionId: string,
    path: string,
    content: Uint8Array | string,
    mime?: string,
  ): Promise<WriteResult> {
    const input = { sessionId, path, content: codec.toBase64(content), ...(mime ? { mime } : {}) };
    return this.http.post('/api/fs/write', input);
  }

  async read(sessionId: string, path: string, options?: ReadOptions): Promise<ReadOutput> {
    const body = {
      sessionId,
      path,
      ...(options?.offset !== undefined ? { offset: options.offset } : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    };
    const result = await this.http.post<{
      path: string;
      offset: number;
      bytes: number;
      checksum: string | null;
      content: string;
    }>('/api/fs/read', body);
    return { ...result, content: codec.toBytes(result.content) };
  }

  async append(
    sessionId: string,
    path: string,
    content: Uint8Array | string,
  ): Promise<WriteResult> {
    return this.http.post('/api/fs/append', {
      sessionId,
      path,
      content: codec.toBase64(content),
    });
  }

  async mkdir(sessionId: string, path: string, recursive = false): Promise<MkdirOutput> {
    return this.http.post('/api/fs/mkdir', { sessionId, path, recursive });
  }

  async list(sessionId: string, path = '/'): Promise<Inode[]> {
    return this.http.post('/api/fs/list', { sessionId, path });
  }

  async move(sessionId: string, from: string, to: string): Promise<MoveOutput> {
    return this.http.post('/api/fs/move', { sessionId, from, to });
  }

  async copy(sessionId: string, from: string, to: string): Promise<CopyOutput> {
    return this.http.post('/api/fs/copy', { sessionId, from, to });
  }

  async remove(sessionId: string, path: string, recursive = false): Promise<RemoveOutput> {
    return this.http.post('/api/fs/delete', { sessionId, path, recursive });
  }

  async stat(sessionId: string, path: string): Promise<Inode> {
    return this.http.post('/api/fs/stat', { sessionId, path });
  }

  async checksum(sessionId: string, path: string): Promise<ChecksumOutput> {
    return this.http.post('/api/fs/checksum', { sessionId, path });
  }

  // ── exec ─────────────────────────────────────────────────────────

  async exec(sessionId: string, command: string, options?: ExecOptions): Promise<Execution> {
    const body = {
      sessionId,
      command,
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      ...(options?.timeout ? { timeout: options.timeout } : {}),
    };
    return this.http.post('/api/exec/run', body);
  }

  async execLog(sessionId: string, options?: ExecLogOptions): Promise<ExecLogOutput> {
    const body = {
      sessionId,
      ...(options?.execId ? { execId: options.execId } : {}),
      ...(options?.offset !== undefined ? { offset: options.offset } : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    };
    return this.http.post('/api/exec/log', body);
  }

  // ── sys ──────────────────────────────────────────────────────────

  async fsync(sessionId?: string): Promise<FsyncOutput> {
    const body = sessionId ? { sessionId } : {};
    return this.http.postRaw('/api/sys/fsync', body);
  }

  async selftest(): Promise<SelftestOutput> {
    return this.http.post('/api/sys/selftest', {});
  }
}

export { codec, HttpTransport, SdkError } from './http.js';
export type { RequestOptions, SdkErrorDetail } from './http.js';
export type {
  CopyOutput,
  ChecksumOutput,
  ExecLogOptions,
  ExecLogOutput,
  ExecOptions,
  FsyncOutput,
  MkdirOutput,
  MoveOutput,
  ReadOptions,
  ReadOutput,
  RemoveOutput,
  SelftestOutput,
  SessionFacade,
  WriteOutput,
} from './session.js';
