import { createHash } from 'node:crypto';
import type {
  BridgeDownloadResult,
  BridgeLike,
  BridgeUploadInput,
  BridgeUploadResult,
} from '@nexuss0781/shared';

export interface MockBridgeEntry {
  msgId: number;
  fileId: string;
  data: Uint8Array;
  meta: BridgeUploadInput;
}

export class MockBridge implements BridgeLike {
  readonly uploads: MockBridgeEntry[] = [];
  private nextMsgId = 1000;
  uploadLatencyMs = 0;
  failUpload = false;
  enabled = true;

  async upload(data: Uint8Array, meta: BridgeUploadInput): Promise<BridgeUploadResult> {
    if (this.uploadLatencyMs > 0) await new Promise((r) => setTimeout(r, this.uploadLatencyMs));
    if (this.failUpload) throw new Error('mock upload failure');
    const msgId = this.nextMsgId++;
    const fileId = `MOCK_FILE_${msgId}`;
    this.uploads.push({ msgId, fileId, data: new Uint8Array(data), meta });
    return { msgId, fileId };
  }

  async download(fileId: string): Promise<BridgeDownloadResult> {
    const entry = this.uploads.find((e) => e.fileId === fileId);
    if (!entry) throw new Error(`mock: unknown file_id ${fileId}`);
    const bytes = entry.data;
    const checksum = createHash('sha256').update(bytes).digest('hex');
    return { bytes, checksum };
  }

  available(): boolean {
    return this.enabled;
  }

  uploadsFor(sessionId: string, path?: string): MockBridgeEntry[] {
    return this.uploads.filter(
      (e) => e.meta.sessionId === sessionId && (path === undefined || e.meta.path === path),
    );
  }

  reset(): void {
    this.uploads.length = 0;
    this.nextMsgId = 1000;
    this.uploadLatencyMs = 0;
    this.failUpload = false;
  }
}
