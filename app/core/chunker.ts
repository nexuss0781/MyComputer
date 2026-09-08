import { createHash } from 'node:crypto';

export interface Chunk {
  seq: number;
  size: number;
  checksum: string;
  data: Uint8Array;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function chunkBytes(data: Uint8Array, maxBytes: number): Chunk[] {
  if (maxBytes <= 0) throw new Error('maxBytes must be positive');
  const chunks: Chunk[] = [];
  let seq = 0;
  for (let offset = 0; offset < data.length; seq++) {
    const end = Math.min(offset + maxBytes, data.length);
    const slice = data.slice(offset, end);
    chunks.push({
      seq,
      size: slice.byteLength,
      checksum: sha256Hex(slice),
      data: slice,
    });
    offset = end;
  }
  return chunks.length === 0
    ? [{ seq: 0, size: 0, checksum: sha256Hex(new Uint8Array(0)), data: new Uint8Array(0) }]
    : chunks;
}

export function recombine(chunks: readonly { seq: number; data: Uint8Array }[]): Uint8Array {
  const ordered = [...chunks].sort((a, b) => a.seq - b.seq);
  const total = ordered.reduce((sum, chunk) => sum + chunk.data.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of ordered) {
    out.set(chunk.data, offset);
    offset += chunk.data.byteLength;
  }
  return out;
}
