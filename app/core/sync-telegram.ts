import { createHash } from 'node:crypto';
import { type BridgeLike, ChecksumError } from '@mycomputer/shared';
import type { BlockRef } from './sync-supabase.js';

export interface TgSinkTarget {
  dirtyPaths(sessionId?: string): Promise<Array<{ sessionId: string; path: string }>>;
  blockRefs(sessionId: string, path: string): Promise<BlockRef[]>;
  annotateTgMsg(
    rows: Array<{ contentId: string; seq: number; tgMsgId: number; fileId: string }>,
  ): Promise<void>;
}

export interface TgSinkStats {
  paths: number;
  chunks: number;
  manifests: number;
  disabled: boolean;
  durationMs: number;
}

const retryDelay = (attempt: number) => Math.min(500 * 2 ** attempt, 8000);

/** Result of uploading one path's chunk set. */
export interface SinkPathResult {
  sessionId: string;
  path: string;
  uploaded: number;
  restored?: { bytes: Uint8Array; checksum: string };
}

/**
 * The out-of-band cold persistence walker. Finds blocks whose tg_msg_id is
 * still null, uploads each chunk to the Telegram Bot API server (via the
 * bridge) in seq order, persists tg_msg_id + file_id back to Supabase, and
 * guarantees chunk-order integrity by never reordering within a path.
 *
 * Retry semantics: each chunk upload is retried with backoff on transient
 * failures. A permanently-failed chunk keeps its row dirty so the next drain
 * retries it — the walker is idempotent and never loses a chunk.
 */
export class TelegramSink {
  constructor(
    private readonly bridge: BridgeLike,
    private readonly target: TgSinkTarget,
    private readonly config: { retries?: number; verify?: boolean } = {},
  ) {}

  available(): boolean {
    return this.bridge.available();
  }

  async drain(sessionId?: string): Promise<TgSinkStats> {
    if (!this.available()) {
      return { paths: 0, chunks: 0, manifests: 0, disabled: true, durationMs: 0 };
    }
    const started = Date.now();
    const dirty = await this.target.dirtyPaths(sessionId);
    let chunks = 0;
    let manifests = 0;

    for (const { sessionId: sid, path } of dirty) {
      const refs = await this.target.blockRefs(sid, path);
      if (refs.length === 0) continue;
      manifests += 1;
      for (const ref of refs) {
        const done = await this.uploadOne(sid, path, ref);
        if (done) chunks += 1;
      }
    }

    return {
      paths: dirty.length,
      chunks,
      manifests,
      disabled: false,
      durationMs: Date.now() - started,
    };
  }

  async restorePath(sessionId: string, path: string): Promise<SinkPathResult> {
    const refs = await this.target.blockRefs(sessionId, path);
    const parts: Array<{ seq: number; bytes: Uint8Array }> = [];
    let uploaded = 0;
    for (const ref of refs) {
      if (ref.data !== null) {
        parts.push({ seq: ref.seq, bytes: ref.data });
        continue;
      }
      if (ref.fileId === null) {
        throw new Error(`block ${ref.seq} of ${path} has neither data nor a Telegram file`);
      }
      const attempt = await this.retryIf(() => this.bridge.download(ref.fileId as string));
      const expected = ref.checksum;
      const actual = createHash('sha256').update(attempt.bytes).digest('hex');
      if (actual !== expected) {
        const retry = await this.retryIf(() => this.bridge.download(ref.fileId as string));
        const retryActual = createHash('sha256').update(retry.bytes).digest('hex');
        if (retryActual !== expected) {
          throw new ChecksumError(`checksum mismatch for ${path} block ${ref.seq}`, {
            sessionId,
            path,
            seq: ref.seq,
          });
        }
        uploaded += 1;
        parts.push({ seq: ref.seq, bytes: retry.bytes });
        continue;
      }
      uploaded += 1;
      parts.push({ seq: ref.seq, bytes: attempt.bytes });
    }
    parts.sort((a, b) => a.seq - b.seq);
    const total = parts.reduce((sum, p) => sum + p.bytes.byteLength, 0);
    const opaque = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      opaque.set(part.bytes, offset);
      offset += part.bytes.byteLength;
    }
    return {
      sessionId,
      path,
      uploaded,
      restored: { bytes: opaque, checksum: createHash('sha256').update(opaque).digest('hex') },
    };
  }

  private async uploadOne(sessionId: string, path: string, ref: BlockRef): Promise<boolean> {
    const data = ref.data;
    if (data === null) {
      return false;
    }
    const result = await this.retryIf(() =>
      this.bridge.upload(data, {
        sessionId,
        path,
        seq: ref.seq,
        checksum: ref.checksum,
        size: ref.size,
      }),
    );
    await this.target.annotateTgMsg([
      { contentId: ref.contentId, seq: ref.seq, tgMsgId: result.msgId, fileId: result.fileId },
    ]);
    return true;
  }

  private async retryIf<T>(action: () => Promise<T>): Promise<T> {
    const retries = this.config.retries ?? 3;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelay(attempt - 1)));
      try {
        return await action();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error('operation failed');
  }
}
