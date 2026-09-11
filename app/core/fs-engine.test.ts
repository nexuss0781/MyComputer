import { ConflictError, NotFoundError, PathError } from '@nexuss0781/shared';
import { describe, expect, it } from 'vitest';
import { makeMemoryEngine } from './selftest.js';

const fromB64 = (value: string) => Buffer.from(value, 'base64').toString('utf8');

async function freshSession() {
  const engine = makeMemoryEngine();
  const sessionId = crypto.randomUUID();
  await engine.sessionInit(sessionId);
  return { engine, sessionId };
}

describe('fs engine (memory backend)', () => {
  it('write/read/append round-trip', async () => {
    const { engine, sessionId } = await freshSession();
    await engine.write(sessionId, '/f.txt', new TextEncoder().encode('hello'));
    const r1 = await engine.read(sessionId, '/f.txt');
    expect(fromB64(r1.content)).toBe('hello');
    await engine.append(sessionId, '/f.txt', new TextEncoder().encode(' world'));
    const r2 = await engine.read(sessionId, '/f.txt');
    expect(fromB64(r2.content)).toBe('hello world');
  });

  it('hides read of a directory and write over a directory', async () => {
    const { engine, sessionId } = await freshSession();
    await engine.mkdir(sessionId, '/d', true);
    await expect(engine.read(sessionId, '/d')).rejects.toThrow();
    const dir = await engine.stat(sessionId, '/d');
    expect(dir.type).toBe('dir');
    await expect(engine.write(sessionId, '/d', new Uint8Array(0))).rejects.toThrow(ConflictError);
  });

  it('move preserves file content and prevents self-move', async () => {
    const { engine, sessionId } = await freshSession();
    await engine.write(sessionId, '/a/f.txt', new TextEncoder().encode('data'));
    await engine.move(sessionId, '/a', '/b');
    await expect(engine.stat(sessionId, '/a')).rejects.toThrow(NotFoundError);
    expect(fromB64((await engine.read(sessionId, '/b/f.txt')).content)).toBe('data');
    await expect(engine.move(sessionId, '/b', '/b/inner')).rejects.toThrow(PathError);
  });

  it('copy duplicates checksums and blocks', async () => {
    const { engine, sessionId } = await freshSession();
    await engine.write(sessionId, '/src/f.txt', new TextEncoder().encode('copy-me'));
    await engine.copy(sessionId, '/src', '/dst');
    expect(fromB64((await engine.read(sessionId, '/dst/f.txt')).content)).toBe('copy-me');
    const a = await engine.checksum(sessionId, '/src/f.txt');
    const b = await engine.checksum(sessionId, '/dst/f.txt');
    expect(b.checksum).toBe(a.checksum);
  });

  it('delete is recursive-guarded and removes blocks', async () => {
    const { engine, sessionId } = await freshSession();
    await engine.write(sessionId, '/tree/leaf.txt', new TextEncoder().encode('x'));
    await expect(engine.remove(sessionId, '/tree')).rejects.toThrow(ConflictError);
    const removed = await engine.remove(sessionId, '/tree', true);
    expect(removed.deleted.length).toBe(2);
    expect(removed.deleted).toEqual(expect.arrayContaining(['/tree', '/tree/leaf.txt']));
    await expect(engine.read(sessionId, '/tree/leaf.txt')).rejects.toThrow(NotFoundError);
  });

  it('journals a record per mutating op', async () => {
    const { engine, sessionId } = await freshSession();
    const before = await engine.oplog.journalCount(sessionId);
    await engine.write(sessionId, '/n.txt', new Uint8Array(0));
    await engine.mkdir(sessionId, '/n-dir', false);
    await engine.append(sessionId, '/n.txt', new Uint8Array([1]));
    await engine.move(sessionId, '/n.txt', '/m.txt');
    await engine.remove(sessionId, '/m.txt');
    const after = await engine.oplog.journalCount(sessionId);
    expect(after - before).toBe(5);
  });

  it('resetSession clears the filesystem', async () => {
    const { engine, sessionId } = await freshSession();
    await engine.write(sessionId, '/x.txt', new Uint8Array([1]));
    await engine.resetSession(sessionId);
    await expect(engine.stat(sessionId, '/')).rejects.toThrow(NotFoundError);
  });
});
