import { z } from 'zod';

export const bridgeUploadSchema = z.object({
  sessionId: z.string().uuid(),
  path: z.string().min(1),
  seq: z.number().int().nonnegative(),
  checksum: z.string().min(1),
  size: z.number().int().nonnegative(),
});

export type BridgeUploadInput = z.infer<typeof bridgeUploadSchema>;

export interface BridgeUploadResult {
  msgId: number;
  fileId: string;
}

export interface BridgeDownloadResult {
  bytes: Uint8Array;
  checksum: string;
}

export interface BridgeLike {
  upload(data: Uint8Array, meta: BridgeUploadInput): Promise<BridgeUploadResult>;
  download(fileId: string): Promise<BridgeDownloadResult>;
  available(): boolean;
}
