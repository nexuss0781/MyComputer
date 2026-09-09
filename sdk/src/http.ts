import { ConflictError, NotFoundError, PathError } from '@mycomputer/shared';

export interface SdkErrorDetail {
  code: string;
  message: string;
}

export class SdkError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SdkError';
    this.code = code;
    this.status = status;
  }
}

export interface RequestOptions {
  fetchFn?: typeof fetch;
}

const statusFromCode = (code: string): number => {
  switch (code) {
    case 'not_found':
    case 'session_not_found':
      return 404;
    case 'invalid_path':
    case 'invalid_input':
    case 'unsupported':
    case 'parent_not_found':
      return 400;
    case 'already_exists':
    case 'not_empty':
      return 409;
    case 'engine_not_configured':
    case 'executor_not_configured':
      return 503;
    default:
      return 500;
  }
};

function toSdkError(payload: SdkErrorDetail, status: number): Error {
  switch (payload.code) {
    case 'not_found':
    case 'session_not_found':
      return new NotFoundError(payload.message);
    case 'invalid_path':
      return new PathError(payload.message);
    case 'already_exists':
    case 'not_empty':
      return new ConflictError(payload.message);
    default:
      return new SdkError(payload.code, payload.message, status);
  }
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: SdkErrorDetail;
}

export class HttpTransport {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(baseUrl: string, options: RequestOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const payload = await this.postEnvelope<T>(path, body);
    if (!payload.ok) {
      throw toSdkError(
        payload.error ?? { code: 'internal', message: 'request failed' },
        this.statusOf(payload),
      );
    }
    return payload.data as T;
  }

  async get<T>(path: string): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`);
    const payload = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !payload?.ok) {
      throw toSdkError(
        payload?.error ?? { code: 'internal', message: `http ${res.status}` },
        res.status,
      );
    }
    return payload.data as T;
  }

  async delete<T>(path: string): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, { method: 'DELETE' });
    const payload = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !payload?.ok) {
      throw toSdkError(
        payload?.error ?? { code: 'internal', message: `http ${res.status}` },
        res.status,
      );
    }
    return payload.data as T;
  }

  /** Posts and returns the full parsed JSON body (for flat-envelope endpoints). */
  async postRaw<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => null)) as T & {
      ok?: boolean;
      error?: unknown;
    };
    if (!res.ok) {
      throw this.flatError(payload);
    }
    return payload as T;
  }

  /** GETs and returns the full parsed JSON body (for flat-envelope endpoints). */
  async getRaw<T>(path: string): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`);
    const payload = (await res.json().catch(() => null)) as T & {
      ok?: boolean;
      error?: unknown;
    };
    if (!res.ok) {
      throw this.flatError(payload);
    }
    return payload as T;
  }

  private flatError(payload: { ok?: boolean; error?: unknown } | null): Error {
    if (payload?.error && typeof payload.error === 'object') {
      const detail = payload.error as SdkErrorDetail;
      return toSdkError(detail, statusFromCode(detail.code ?? 'internal'));
    }
    const message = typeof payload?.error === 'string' ? payload.error : 'request failed';
    return new SdkError('request_failed', message, 500);
  }

  private async postEnvelope<T>(path: string, body: unknown): Promise<Envelope<T>> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json().catch(() => null)) as Envelope<T>;
  }

  private statusOf(payload: Envelope<unknown>): number {
    if (payload.error?.code) return statusFromCode(payload.error.code);
    return 500;
  }
}

export interface ContentCodec {
  toBase64(content: Uint8Array | string): string;
  toBytes(base64: string): Uint8Array;
  toText(bytes: Uint8Array): string;
}

export const codec: ContentCodec = {
  toBase64(content) {
    if (typeof content === 'string') return Buffer.from(content, 'utf8').toString('base64');
    return Buffer.from(content).toString('base64');
  },
  toBytes(base64) {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  },
  toText(bytes) {
    return Buffer.from(bytes).toString('utf8');
  },
};
