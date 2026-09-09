import { createHash } from 'node:crypto';
import type {
  BridgeDownloadResult,
  BridgeLike,
  BridgeUploadInput,
  BridgeUploadResult,
} from './bridge.js';

interface BridgeClientConfig {
  baseUrl: string;
  token: string;
  channelId: string;
  fetchFn?: typeof fetch;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

interface SendDocumentResult {
  message_id: number;
  document?: { file_id: string; file_unique_id: string; file_size: number; file_path: string };
  caption?: string;
}

interface GetFileResult {
  file_id: string;
  file_unique_id: string;
  file_size: number;
  file_path: string;
}

const retryDelay = (attempt: number) => Math.min(500 * 2 ** attempt, 8000);
const MAX_RETRIES = 3;
const TRANSIENT_CODES = new Set([429, 500, 502, 503, 504]);

export class BridgeClient implements BridgeLike {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly channelId: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: BridgeClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
    this.channelId = config.channelId;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  available(): boolean {
    return Boolean(this.baseUrl && this.token && this.channelId);
  }

  async upload(data: Uint8Array, meta: BridgeUploadInput): Promise<BridgeUploadResult> {
    const caption = JSON.stringify({
      sessionId: meta.sessionId,
      path: meta.path,
      seq: meta.seq,
      checksum: meta.checksum,
      size: meta.size,
    });
    const filename = `${meta.path.replace(/\//g, '_')}_${meta.seq}.bin`;
    const formData = new FormData();
    formData.append('chat_id', this.channelId);
    formData.append('document', new Blob([data]), filename);
    formData.append('caption', caption);
    const result = await this.request<SendDocumentResult>('/sendDocument', {
      method: 'POST',
      body: formData,
    });
    if (!result.document) {
      throw new Error('sendDocument returned no document');
    }
    return { msgId: result.message_id, fileId: result.document.file_id };
  }

  async download(fileId: string): Promise<BridgeDownloadResult> {
    const getFileResp = await this.request<GetFileResult>('/getFile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    });
    const fileUrl = `${this.baseUrl}/file/bot/${this.token}/${getFileResp.file_path}`;
    const resp = await this.fetchFn(fileUrl);
    if (!resp.ok) {
      throw new Error(`file download failed: ${resp.status} ${resp.statusText}`);
    }
    const buffer = await resp.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    return { bytes, checksum };
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const url = `${this.baseUrl}/bot/${this.token}${path}`;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, retryDelay(attempt - 1)));
      }
      try {
        const resp = await this.fetchFn(url, init);
        const body = (await resp.json()) as TelegramApiResponse<T>;
        if (body.ok && body.result !== undefined) {
          return body.result;
        }
        const code = body.error_code ?? resp.status;
        const desc = body.description ?? resp.statusText;
        if (TRANSIENT_CODES.has(code)) {
          lastError = new Error(`telegram ${code}: ${desc}`);
          continue;
        }
        throw new Error(`telegram ${code}: ${desc}`);
      } catch (error) {
        if (error instanceof Error && /telegram \d+/.test(error.message)) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error('bridge request failed');
  }
}
