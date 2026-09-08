import { describe, expect, it } from 'vitest';
import { chunkBytes, recombine, sha256Hex } from './chunker.js';

describe('chunker', () => {
  it('produces a single zero-sized chunk for empty input', () => {
    const chunks = chunkBytes(new Uint8Array(0), 8);
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.size).toBe(0);
  });

  it('splits at the max boundary', () => {
    const data = new Uint8Array(20);
    for (let i = 0; i < data.length; i++) data[i] = i;
    const chunks = chunkBytes(data, 8);
    expect(chunks.map((c) => c.size)).toEqual([8, 8, 4]);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
  });

  it('round-trips byte-identical through recombine', () => {
    const raw = new Uint8Array(10 * 1024 * 1024);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 31) % 256;
    const back = recombine(chunkBytes(raw, 1024 * 1024));
    expect(back.byteLength).toBe(raw.byteLength);
    expect(Buffer.from(back).equals(Buffer.from(raw))).toBe(true);
  });

  it('checksums are stable sha256 hex', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
