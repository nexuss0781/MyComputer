import { randomUUID } from 'node:crypto';
import {
  ComputerError,
  ConflictError,
  type Inode,
  NotFoundError,
  PathError,
  type ReadResult,
  type WriteResult,
} from '@mycomputer/shared';
import type { FsBackend } from './backend.js';
import { chunkBytes, recombine, sha256Hex } from './chunker.js';
import type { Oplog } from './oplog.js';
import { basename, isStrictSubpath, isSubpathOrEqual, normalizePath, parentOf } from './path.js';

const cacheKey = (sessionId: string, path: string) => `${sessionId}::${path}`;

const errStatus = (error: unknown): { code: string; message: string } => {
  if (error instanceof ComputerError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: 'internal', message: error.message };
  return { code: 'internal', message: 'unknown error' };
};

interface WritePlan {
  dirs: Inode[];
  inode: Inode;
  chunks: { seq: number; size: number; checksum: string; data: Uint8Array }[];
  contentId: string;
  result: WriteResult;
}

export class FsEngine {
  private readonly cache = new Map<string, Inode>();

  constructor(
    private readonly backend: FsBackend,
    readonly oplog: Oplog,
    private readonly maxChunkBytes = 8 * 1024 * 1024,
  ) {}

  private async resolve(sessionId: string, path: string): Promise<Inode> {
    const hit = this.cache.get(cacheKey(sessionId, path));
    if (hit) return hit;
    const inode = await this.backend.getInode(sessionId, path);
    if (!inode) throw new NotFoundError(`${path} does not exist`);
    this.cache.set(cacheKey(sessionId, path), inode);
    return inode;
  }

  private evictSubtree(sessionId: string, root: string): void {
    for (const [key, inode] of this.cache) {
      if (inode.sessionId === sessionId && isSubpathOrEqual(inode.path, root))
        this.cache.delete(key);
    }
  }

  private async collectParents(sessionId: string, path: string): Promise<Inode[]> {
    let parent = parentOf(path);
    const chain: string[] = [];
    while (parent !== null && parent !== '/') {
      const exists = await this.backend.getInode(sessionId, parent);
      if (exists) {
        if (exists.type !== 'dir') throw new ConflictError(`${parent} is not a directory`);
        break;
      }
      chain.push(parent);
      parent = parentOf(parent);
    }
    return chain.reverse().map((dirPath) => {
      const inode: Inode = {
        path: dirPath,
        sessionId,
        type: 'dir',
        mode: 420,
        size: 0,
        mime: null,
        checksum: null,
        parent: parentOf(dirPath),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.cache.set(cacheKey(sessionId, dirPath), inode);
      return inode;
    });
  }

  async write(
    sessionId: string,
    rawPath: string,
    content: Uint8Array,
    mime?: string,
  ): Promise<WriteResult> {
    const path = normalizePath(rawPath);
    const started = Date.now();
    const input = {
      path,
      bytes: content.byteLength,
      mime: mime ?? null,
      content: Buffer.from(content).toString('base64'),
    };
    try {
      const plan = await this.computeWrite(sessionId, path, content, mime);
      const result = {
        path: plan.result.path,
        size: plan.result.size,
        checksum: plan.result.checksum,
        blocks: plan.result.blocks,
      };
      await this.oplog.record('write', sessionId, input, result, 'ok', Date.now() - started);
      this.applyWrite(sessionId, plan);
      return result;
    } catch (error) {
      await this.oplog.recordError(
        'write',
        sessionId,
        { path, bytes: content.byteLength },
        errStatus(error),
        Date.now() - started,
      );
      throw error;
    }
  }

  private async computeWrite(
    sessionId: string,
    path: string,
    content: Uint8Array,
    mime?: string,
  ): Promise<WritePlan> {
    if (path === '/') throw new PathError('cannot write the root directory');
    const existing = await this.backend.getInode(sessionId, path);
    if (existing?.type === 'dir') throw new ConflictError(`${path} is a directory`);
    const dirs = await this.collectParents(sessionId, path);

    const chunks = chunkBytes(content, this.maxChunkBytes);
    const checksum = sha256Hex(content);
    const inode: Inode = {
      path,
      sessionId,
      type: 'file',
      mode: existing?.mode ?? 420,
      size: content.byteLength,
      mime: mime ?? existing?.mime ?? null,
      checksum,
      parent: parentOf(path),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return {
      dirs,
      inode,
      chunks,
      contentId: randomUUID(),
      result: { path, size: inode.size, checksum, blocks: chunks.length },
    };
  }

  private applyWrite(sessionId: string, plan: WritePlan): void {
    for (const dir of plan.dirs) this.backend.upsertInode(dir);
    this.backend.upsertInode(plan.inode);
    this.backend.insertBlocks(sessionId, plan.inode.path, plan.contentId, plan.chunks);
    this.cache.set(cacheKey(sessionId, plan.inode.path), plan.inode);
  }

  async read(sessionId: string, rawPath: string, offset = 0, limit?: number): Promise<ReadResult> {
    const path = normalizePath(rawPath);
    if (offset < 0) throw new PathError('offset must be non-negative');
    if (limit !== undefined && limit <= 0) throw new PathError('limit must be positive');
    const started = Date.now();
    const input = { path, offset, limit: limit ?? null };
    try {
      const inode = await this.resolve(sessionId, path);
      if (inode.type !== 'file')
        throw new ComputerError('unsupported', `${path} is not a file`, 400);
      const rows = await this.backend.getBlocks(sessionId, path);
      const all = recombine(rows);
      const slice = all.slice(offset, limit === undefined ? undefined : offset + limit);
      const result: ReadResult = {
        path,
        content: Buffer.from(slice).toString('base64'),
        offset,
        bytes: slice.byteLength,
        checksum: inode.checksum,
      };
      await this.oplog.record(
        'read',
        sessionId,
        input,
        { path, bytes: result.bytes },
        'ok',
        Date.now() - started,
      );
      return result;
    } catch (error) {
      await this.oplog.recordError(
        'read',
        sessionId,
        input,
        errStatus(error),
        Date.now() - started,
      );
      throw error;
    }
  }

  async append(sessionId: string, rawPath: string, content: Uint8Array): Promise<WriteResult> {
    const path = normalizePath(rawPath);
    const started = Date.now();
    const input = {
      path,
      bytes: content.byteLength,
      content: Buffer.from(content).toString('base64'),
    };
    try {
      const existing = await this.resolve(sessionId, path);
      if (existing.type !== 'file')
        throw new ComputerError('unsupported', `${path} is not a file`, 400);
      const current = recombine(await this.backend.getBlocks(sessionId, path));
      const merged = new Uint8Array(current.byteLength + content.byteLength);
      merged.set(current, 0);
      merged.set(content, current.byteLength);
      const plan = await this.computeWrite(sessionId, path, merged, existing.mime ?? undefined);
      const result = {
        path: plan.result.path,
        size: plan.result.size,
        checksum: plan.result.checksum,
        blocks: plan.result.blocks,
      };
      await this.oplog.record('append', sessionId, input, result, 'ok', Date.now() - started);
      this.applyWrite(sessionId, plan);
      return result;
    } catch (error) {
      await this.oplog.recordError(
        'append',
        sessionId,
        input,
        errStatus(error),
        Date.now() - started,
      );
      throw error;
    }
  }

  async mkdir(sessionId: string, rawPath: string, recursive = false): Promise<{ path: string }> {
    const path = normalizePath(rawPath);
    if (path === '/') throw new PathError('root already exists');
    const started = Date.now();
    const input = { path, recursive };
    try {
      const existing = await this.backend.getInode(sessionId, path);
      if (existing?.type === 'dir' && recursive) return { path };
      if (existing) throw new ConflictError(`${path} already exists`);
      const parents = recursive ? await this.collectParents(sessionId, path) : [];
      if (!recursive) {
        const parent = parentOf(path);
        if (parent !== null) {
          const p = await this.backend.getInode(sessionId, parent);
          if (!p) throw new NotFoundError(`parent ${parent} does not exist`);
          if (p.type !== 'dir') throw new ConflictError(`${parent} is not a directory`);
        }
      }
      const inode: Inode = {
        path,
        sessionId,
        type: 'dir',
        mode: 420,
        size: 0,
        mime: null,
        checksum: null,
        parent: parentOf(path),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const result = { path };
      await this.oplog.record('mkdir', sessionId, input, result, 'ok', Date.now() - started);
      for (const dir of parents) this.backend.upsertInode(dir);
      this.backend.upsertInode(inode);
      this.cache.set(cacheKey(sessionId, path), inode);
      return result;
    } catch (error) {
      await this.oplog.recordError(
        'mkdir',
        sessionId,
        input,
        errStatus(error),
        Date.now() - started,
      );
      throw error;
    }
  }

  async list(sessionId: string, rawPath: string): Promise<Inode[]> {
    const path = normalizePath(rawPath);
    const started = Date.now();
    const input = { path };
    try {
      const inode = await this.resolve(sessionId, path);
      if (inode.type !== 'dir')
        throw new ComputerError('unsupported', `${path} is not a directory`, 400);
      const children = (await this.backend.getSessionInodes(sessionId))
        .filter((child) => child.parent === path)
        .sort((a, b) => a.path.localeCompare(b.path));
      await this.oplog.record(
        'list',
        sessionId,
        input,
        { paths: children.map((c) => c.path) },
        'ok',
        Date.now() - started,
      );
      return children;
    } catch (error) {
      await this.oplog.recordError(
        'list',
        sessionId,
        input,
        errStatus(error),
        Date.now() - started,
      );
      throw error;
    }
  }

  async move(
    sessionId: string,
    fromRaw: string,
    toRaw: string,
  ): Promise<{ from: string; to: string }> {
    const from = normalizePath(fromRaw);
    const to = normalizePath(toRaw);
    if (from === to) throw new PathError('source and destination are the same');
    if (from === '/' || to === '/') throw new PathError('cannot operate on the root directory');
    if (isSubpathOrEqual(to, from) && to !== from)
      throw new PathError('cannot move a directory into itself');
    const started = Date.now();
    const input = { from, to };
    try {
      await this.resolve(sessionId, from);
      const existing = await this.backend.getInode(sessionId, to);
      if (existing) throw new ConflictError(`${to} already exists`);

      const all = await this.backend.getSessionInodes(sessionId);
      const subtree = all.filter((n) => isSubpathOrEqual(n.path, from));
      for (const node of subtree) {
        const newPath = to + node.path.slice(from.length);
        const moved: Inode = {
          ...node,
          path: newPath,
          parent: parentOf(newPath),
          updatedAt: new Date().toISOString(),
        };
        await this.backend.upsertInode(moved);
        if (node.type === 'file') {
          await this.backend.renameBlockPath(sessionId, node.path, newPath);
        }
      }
      await this.backend.removeInodes(
        sessionId,
        subtree.map((n) => n.path),
      );
      this.evictSubtree(sessionId, from);
      const result = { from, to, moved: subtree.length };
      await this.oplog.record('move', sessionId, input, result, 'ok', Date.now() - started);
      return result;
    } catch (error) {
      await this.oplog.recordError(
        'move',
        sessionId,
        input,
        errStatus(error),
        Date.now() - started,
      );
      throw error;
    }
  }

  async copy(
    sessionId: string,
    fromRaw: string,
    toRaw: string,
  ): Promise<{ from: string; to: string }> {
    const from = normalizePath(fromRaw);
    const to = normalizePath(toRaw);
    if (from === to) throw new PathError('source and destination are the same');
    if (from === '/' || to === '/') throw new PathError('cannot operate on the root directory');
    if (isSubpathOrEqual(to, from) && to !== from)
      throw new PathError('cannot copy a directory into itself');
    const started = Date.now();
    const input = { from, to };
    try {
      await this.resolve(sessionId, from);
      const existing = await this.backend.getInode(sessionId, to);
      if (existing) throw new ConflictError(`${to} already exists`);

      const all = await this.backend.getSessionInodes(sessionId);
      const subtree = all.filter((n) => isSubpathOrEqual(n.path, from));
      for (const node of subtree) {
        const newPath = to + node.path.slice(from.length);
        if (node.type === 'dir') {
          const dir: Inode = {
            ...node,
            path: newPath,
            parent: parentOf(newPath),
            updatedAt: new Date().toISOString(),
          };
          await this.backend.upsertInode(dir);
        } else {
          const rows = await this.backend.getBlocks(sessionId, node.path);
          const copied: Inode = {
            ...node,
            path: newPath,
            parent: parentOf(newPath),
            updatedAt: new Date().toISOString(),
          };
          await this.backend.upsertInode(copied);
          await this.backend.insertBlocks(
            sessionId,
            newPath,
            randomUUID(),
            rows.map((r) => ({ seq: r.seq, size: r.size, checksum: r.checksum, data: r.data })),
          );
        }
      }
      const result = { from, to, copied: subtree.length };
      await this.oplog.record('copy', sessionId, input, result, 'ok', Date.now() - started);
      return result;
    } catch (error) {
      await this.oplog.recordError(
        'copy',
        sessionId,
        input,
        errStatus(error),
        Date.now() - started,
      );
      throw error;
    }
  }

  async remove(
    sessionId: string,
    rawPath: string,
    recursive = false,
  ): Promise<{ deleted: string[] }> {
    const path = normalizePath(rawPath);
    if (path === '/') throw new PathError('cannot delete the root directory');
    const started = Date.now();
    const input = { path, recursive };
    try {
      await this.resolve(sessionId, path);
      const all = await this.backend.getSessionInodes(sessionId);
      const subtree = all.filter((n) => isSubpathOrEqual(n.path, path));
      if (!recursive && subtree.length > 1) {
        throw new ConflictError(`${path} is not empty`);
      }
      const paths = subtree.map((n) => n.path);
      await this.backend.removeInodes(sessionId, paths);
      await this.backend.removeBlocksByPaths(sessionId, paths);
      this.evictSubtree(sessionId, path);
      const result = { deleted: paths };
      await this.oplog.record('delete', sessionId, input, result, 'ok', Date.now() - started);
      return result;
    } catch (error) {
      await this.oplog.recordError(
        'delete',
        sessionId,
        input,
        errStatus(error),
        Date.now() - started,
      );
      throw error;
    }
  }

  async stat(sessionId: string, rawPath: string): Promise<Inode> {
    const path = normalizePath(rawPath);
    const started = Date.now();
    const input = { path };
    try {
      const inode = await this.resolve(sessionId, path);
      await this.oplog.record(
        'stat',
        sessionId,
        input,
        { path, size: inode.size, type: inode.type },
        'ok',
        Date.now() - started,
      );
      return inode;
    } catch (error) {
      await this.oplog.recordError(
        'stat',
        sessionId,
        input,
        errStatus(error),
        Date.now() - started,
      );
      throw error;
    }
  }

  async checksum(sessionId: string, rawPath: string): Promise<{ path: string; checksum: string }> {
    const path = normalizePath(rawPath);
    const started = Date.now();
    const input = { path };
    try {
      const inode = await this.resolve(sessionId, path);
      if (inode.type !== 'file')
        throw new ComputerError('unsupported', `${path} is not a file`, 400);
      const result = {
        path,
        checksum:
          inode.checksum ?? sha256Hex(recombine(await this.backend.getBlocks(sessionId, path))),
      };
      await this.oplog.record('checksum', sessionId, input, result, 'ok', Date.now() - started);
      return result;
    } catch (error) {
      await this.oplog.recordError(
        'checksum',
        sessionId,
        input,
        errStatus(error),
        Date.now() - started,
      );
      throw error;
    }
  }

  async resetSession(sessionId: string): Promise<void> {
    await this.backend.deleteSessionData(sessionId);
    this.evictSubtree(sessionId, '/');
    this.cache.clear();
  }

  async sessionInit(sessionId: string): Promise<void> {
    const existing = await this.backend.getInode(sessionId, '/');
    if (existing) return;
    const root: Inode = {
      path: '/',
      sessionId,
      type: 'dir',
      mode: 420,
      size: 0,
      mime: null,
      checksum: null,
      parent: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.backend.upsertInode(root);
    this.cache.set(cacheKey(sessionId, '/'), root);
  }
}

export { isSubpathOrEqual, isStrictSubpath, basename };
