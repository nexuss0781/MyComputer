import { createHash } from 'node:crypto';

/**
 * Deterministic UUID v5-like from a seed string. Used as content_id so
 * the same (session, path, checksum) always maps to the same row — enabling
 * idempotent upsert on the PK (content_id, seq) during reconcile.
 */
export function uuidFromSeed(seed: string): string {
  const hash = createHash('sha256').update(seed).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  const b6 = bytes[6];
  const b8 = bytes[8];
  if (b6 !== undefined && b8 !== undefined) {
    bytes[6] = (b6 & 0x0f) | 0x50;
    bytes[8] = (b8 & 0x3f) | 0x80;
  }
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
