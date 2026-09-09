import type { WriteResult } from '@mycomputer/shared';
import type { ComputerClient } from './index.js';
import type { ReadOptions } from './session.js';

export interface StreamReadOptions extends ReadOptions {
  /** Page size in bytes for each ranged read (defaults to the client's chunkSize). */
  chunkSize?: number;
}

export interface WriteAllOptions {
  mime?: string;
  /** Chunk byte size: the first chunk is written via `write`, the rest via `append`. */
  chunkSize?: number;
}

/**
 * Reads a file in ranged pages, yielding each page as a fresh Uint8Array.
 * Pagination uses the server's returned byte count to advance the offset.
 */
export async function* streamRead(
  client: ComputerClient,
  sessionId: string,
  path: string,
  options: StreamReadOptions = {},
): AsyncGenerator<Uint8Array> {
  const pageSize = options.chunkSize ?? client.chunkSize;
  let offset = options.offset ?? 0;
  let guard = 0;
  const maxPages = 1_000_000;
  while (guard < maxPages) {
    const page = await client.read(sessionId, path, { offset, limit: pageSize });
    if (page.bytes === 0) break;
    yield page.content;
    offset += page.bytes;
    if (page.bytes < pageSize) break;
    guard++;
  }
}

/**
 * Reads an entire file into a single Uint8Array, paging automatically.
 */
export async function readAll(
  client: ComputerClient,
  sessionId: string,
  path: string,
  options: StreamReadOptions = {},
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of streamRead(client, sessionId, path, options)) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const merged = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    merged.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return merged;
}

/**
 * Reads a file and decodes it as UTF-8 text.
 */
export async function readText(
  client: ComputerClient,
  sessionId: string,
  path: string,
  options: StreamReadOptions = {},
): Promise<string> {
  return new TextDecoder().decode(await readAll(client, sessionId, path, options));
}

/**
 * Writes content larger than a single chunk. The first chunk uses `write`
 * (creating the file); each subsequent chunk appends. Returns the final inode
 * write result (full size, whole-file checksum, block count).
 */
export async function writeAll(
  client: ComputerClient,
  sessionId: string,
  path: string,
  content: Uint8Array | string,
  options: WriteAllOptions = {},
): Promise<WriteResult> {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  if (bytes.byteLength === 0) {
    return client.write(sessionId, path, bytes, options.mime);
  }
  const chunkSize = options.chunkSize ?? client.chunkSize;
  if (bytes.byteLength <= chunkSize) {
    return client.write(sessionId, path, bytes, options.mime);
  }
  let result: WriteResult = await client.write(
    sessionId,
    path,
    bytes.subarray(0, chunkSize),
    options.mime,
  );
  for (let off = chunkSize; off < bytes.byteLength; off += chunkSize) {
    result = await client.append(sessionId, path, bytes.subarray(off, off + chunkSize));
  }
  return result;
}

/**
 * Convenience: writes a UTF-8 string via `writeAll`.
 */
export async function writeText(
  client: ComputerClient,
  sessionId: string,
  path: string,
  text: string,
  options: WriteAllOptions = {},
): Promise<WriteResult> {
  return writeAll(client, sessionId, path, new TextEncoder().encode(text), options);
}
