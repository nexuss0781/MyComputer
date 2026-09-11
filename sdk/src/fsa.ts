import { Readable, Writable } from 'node:stream';
import type { Inode } from '@mycomputer/shared';
import { readAll, writeAll } from './fssio.js';
import type { ComputerClient } from './index.js';

// ── Stat-like object (subset of Node fs.Stats) ──────────────────────

export interface VirtualFsStat {
  size: number;
  mode: number;
  mtime: Date;
  ctime: Date;
  birthtime: Date;
  atime: Date;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

// ── Dirent-like object ─────────────────────────────────────────────

export interface VirtualFsDirent {
  name: string;
  path: string;
  parentPath: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

// ── FileHandle ──────────────────────────────────────────────────────

export class VirtualFsFileHandle {
  readonly #client: ComputerClient;
  readonly #sessionId: string;
  readonly #path: string;
  #closed = false;

  constructor(client: ComputerClient, sessionId: string, path: string) {
    this.#client = client;
    this.#sessionId = sessionId;
    this.#path = path;
  }

  get fd(): number {
    return -1;
  }

  get path(): string {
    return this.#path;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async read(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  ): Promise<{ bytesRead: number; buffer: Uint8Array }> {
    this.#assertOpen();
    const readOffset = position ?? offset ?? 0;
    const readLength = length ?? buffer.byteLength;
    const result = await this.#client.read(this.#sessionId, this.#path, {
      offset: readOffset,
      limit: readLength,
    });
    const dest = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const readBytes = result.content;
    const len = Math.min(readBytes.byteLength, dest.byteLength);
    dest.set(readBytes.subarray(0, len), offset ?? 0);
    return { bytesRead: len, buffer: dest };
  }

  async write(
    data: Uint8Array | string,
    offset?: number,
    _length?: number,
    position?: number,
  ): Promise<{ bytesWritten: number; buffer: Uint8Array | string }> {
    this.#assertOpen();
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const pos = position ?? offset ?? 0;
    if (pos === 0) {
      const result = await this.#client.write(this.#sessionId, this.#path, bytes);
      return { bytesWritten: result.size, buffer: bytes };
    }
    const _result = await this.#client.append(this.#sessionId, this.#path, bytes);
    return { bytesWritten: bytes.byteLength, buffer: bytes };
  }

  async stat(): Promise<VirtualFsStat> {
    this.#assertOpen();
    const inode = await this.#client.stat(this.#sessionId, this.#path);
    return inodeToStat(inode);
  }

  async truncate(len?: number): Promise<void> {
    this.#assertOpen();
    if (len === undefined || len === 0) {
      await this.#client.write(this.#sessionId, this.#path, new Uint8Array(0));
    } else {
      const result = await this.#client.read(this.#sessionId, this.#path, {
        offset: 0,
        limit: len,
      });
      await this.#client.write(this.#sessionId, this.#path, result.content);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('FileHandle is closed');
  }
}

// ── VirtualFs ───────────────────────────────────────────────────────

export interface VirtualFsConfig {
  /** Flush (fsync) after writeFile/appendFile. Default false. */
  flushOnWrite?: boolean;
  /** TTL for cached inodes in ms. 0 = no TTL (default, invalidate on mutation). */
  cacheTtlMs?: number;
}

export class VirtualFs {
  readonly #client: ComputerClient;
  readonly #sessionId: string;
  readonly #config: VirtualFsConfig;
  readonly #cache = new Map<string, Inode>();
  readonly #dirCache = new Map<string, Inode[]>();

  constructor(client: ComputerClient, sessionId: string, config: VirtualFsConfig = {}) {
    this.#client = client;
    this.#sessionId = sessionId;
    this.#config = config;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  // ── read / write ────────────────────────────────────────────────

  async readFile(path: string): Promise<Buffer> {
    const data = await readAll(this.#client, this.#sessionId, path);
    return Buffer.from(data);
  }

  async writeFile(
    path: string,
    data: Buffer | string | Uint8Array,
    _options?: { mode?: number; flag?: string },
  ): Promise<void> {
    const bytes =
      typeof data === 'string'
        ? Buffer.from(data, 'utf8')
        : data instanceof Buffer
          ? data
          : new Uint8Array(data);
    await writeAll(this.#client, this.#sessionId, path, bytes);
    this.#invalidateMutated(path);
    if (this.#config.flushOnWrite) await this.#client.fsync(this.#sessionId);
  }

  async appendFile(path: string, data: Buffer | string | Uint8Array): Promise<void> {
    const bytes =
      typeof data === 'string'
        ? Buffer.from(data, 'utf8')
        : data instanceof Buffer
          ? data
          : new Uint8Array(data);
    await this.#client.append(this.#sessionId, path, bytes);
    this.#invalidateMutated(path);
    if (this.#config.flushOnWrite) await this.#client.fsync(this.#sessionId);
  }

  // ── metadata ────────────────────────────────────────────────────

  async stat(path: string): Promise<VirtualFsStat> {
    const cached = this.#cache.get(path);
    if (cached && !this.#isExpired(cached)) return inodeToStat(cached);
    const inode = await this.#client.stat(this.#sessionId, path);
    this.#cache.set(path, inode);
    return inodeToStat(inode);
  }

  async lstat(path: string): Promise<VirtualFsStat> {
    return this.stat(path);
  }

  async access(path: string): Promise<void> {
    await this.#client.stat(this.#sessionId, path);
  }

  // ── directory ops ───────────────────────────────────────────────

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined> {
    const res = await this.#client.mkdir(this.#sessionId, path, options?.recursive ?? false);
    this.#dirCache.delete(dirname(path));
    return res.path;
  }

  async readdir(
    path: string,
    options?: { withFileTypes?: boolean },
  ): Promise<string[] | VirtualFsDirent[]> {
    const dirKey = `${path}`;
    const cached = this.#dirCache.get(dirKey);
    const entries = cached ?? (await this.#client.list(this.#sessionId, path));
    if (!cached) this.#dirCache.set(dirKey, entries);

    if (options?.withFileTypes) {
      return entries.map((e) => ({
        name: basename(e.path),
        path: e.path,
        parentPath: path,
        isFile: () => e.type === 'file',
        isDirectory: () => e.type === 'dir',
        isSymbolicLink: () => false,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
      }));
    }
    return entries.map((e) => basename(e.path));
  }

  // ── rename / copy / delete ─────────────────────────────────────

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.#client.move(this.#sessionId, oldPath, newPath);
    this.#invalidateRenamed(oldPath, newPath);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    await this.#client.copy(this.#sessionId, src, dest);
    this.#invalidateCopied(dest);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    try {
      await this.#client.remove(this.#sessionId, path, options?.recursive ?? false);
    } catch (err: unknown) {
      if (options?.force && isNotFoundError(err)) return;
      throw err;
    }
    this.#invalidateMutated(path);
    this.#dirCache.delete(dirname(path));
  }

  async unlink(path: string): Promise<void> {
    await this.#client.remove(this.#sessionId, path, false);
    this.#invalidateMutated(path);
    this.#dirCache.delete(dirname(path));
  }

  async rmdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.#client.remove(this.#sessionId, path, options?.recursive ?? false);
    this.#invalidateMutated(path);
    this.#dirCache.delete(dirname(path));
  }

  // ── open (FileHandle) ──────────────────────────────────────────

  async open(path: string, _flags?: string | number, _mode?: number): Promise<VirtualFsFileHandle> {
    await this.#client.stat(this.#sessionId, path);
    return new VirtualFsFileHandle(this.#client, this.#sessionId, path);
  }

  // ── streams ────────────────────────────────────────────────────

  createReadStream(
    path: string,
    options?: { start?: number; end?: number; highWaterMark?: number },
  ): Readable {
    const offset = options?.start ?? 0;
    const pageSize = 8 * 1024 * 1024;
    let pos = offset;
    const client = this.#client;
    const sid = this.#sessionId;
    let done = false;

    return new Readable({
      async read() {
        if (done) {
          this.push(null);
          return;
        }
        try {
          const page = await client.read(sid, path, { offset: pos, limit: pageSize });
          if (page.bytes === 0) {
            done = true;
            this.push(null);
            return;
          }
          pos += page.bytes;
          if (page.bytes < pageSize) done = true;
          this.push(Buffer.from(page.content));
        } catch (err) {
          this.destroy(err as Error);
        }
      },
    });
  }

  createWriteStream(path: string, _options?: { highWaterMark?: number }): Writable {
    const chunks: Uint8Array[] = [];
    const client = this.#client;
    const sid = this.#sessionId;

    return new Writable({
      write(chunk: Uint8Array, _encoding: BufferEncoding, callback: (err?: Error | null) => void) {
        chunks.push(chunk);
        callback();
      },
      async final(callback: (err?: Error | null) => void) {
        try {
          const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
          const merged = new Uint8Array(total);
          let pos = 0;
          for (const chunk of chunks) {
            merged.set(chunk, pos);
            pos += chunk.byteLength;
          }
          await writeAll(client, sid, path, merged);
          callback();
        } catch (err) {
          callback(err as Error);
        }
      },
    });
  }

  // ── cache management ───────────────────────────────────────────

  clearCache(): void {
    this.#cache.clear();
    this.#dirCache.clear();
  }

  #isExpired(inode: Inode): boolean {
    const ttl = this.#config.cacheTtlMs;
    if (!ttl) return false;
    return Date.now() - new Date(inode.updatedAt).getTime() > ttl;
  }

  #invalidateMutated(path: string): void {
    this.#cache.delete(path);
    this.#dirCache.clear();
  }

  #invalidateRenamed(oldPath: string, newPath: string): void {
    this.#cache.delete(oldPath);
    this.#cache.delete(newPath);
    this.#dirCache.clear();
  }

  #invalidateCopied(dest: string): void {
    this.#cache.delete(dest);
    this.#dirCache.clear();
  }
}

// ── helpers ─────────────────────────────────────────────────────────

function inodeToStat(inode: Inode): VirtualFsStat {
  const mtime = new Date(inode.updatedAt);
  const ctime = new Date(inode.updatedAt);
  const birthtime = new Date(inode.createdAt);
  return {
    size: inode.size,
    mode: inode.mode,
    mtime,
    ctime,
    birthtime,
    atime: mtime,
    isFile: () => inode.type === 'file',
    isDirectory: () => inode.type === 'dir',
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? path : path.slice(idx + 1);
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as { code?: string }).code === 'NOT_FOUND';
}
