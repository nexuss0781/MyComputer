import { describe, expect, it } from 'vitest';
import {
  deleteSchema,
  execLogSchema,
  execRunSchema,
  mkdirSchema,
  moveSchema,
  readSchema,
  sessionCreateSchema,
  writeSchema,
} from './schemas.js';

describe('fs schemas', () => {
  it('accepts a valid write payload', () => {
    const parsed = writeSchema.safeParse({
      sessionId: crypto.randomUUID(),
      path: '/a/b.txt',
      content: 'aGVsbG8=',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-uuid sessionId', () => {
    expect(writeSchema.safeParse({ sessionId: 'nope', path: '/a', content: '' }).success).toBe(
      false,
    );
  });

  it('rejects empty or oversized paths', () => {
    expect(
      writeSchema.safeParse({ sessionId: crypto.randomUUID(), path: '', content: '' }).success,
    ).toBe(false);
    expect(
      writeSchema.safeParse({ sessionId: crypto.randomUUID(), path: '/'.repeat(5000), content: '' })
        .success,
    ).toBe(false);
  });

  it('readSchema bounds offset and limit', () => {
    const base = { sessionId: crypto.randomUUID(), path: '/a' };
    expect(readSchema.safeParse({ ...base, offset: -1 }).success).toBe(false);
    expect(readSchema.safeParse({ ...base, limit: 0 }).success).toBe(false);
    expect(readSchema.safeParse({ ...base, offset: 5, limit: 10 }).success).toBe(true);
  });

  it('move and copy require from and to', () => {
    const base = { sessionId: crypto.randomUUID() };
    expect(moveSchema.safeParse({ ...base, from: '/a', to: '/b' }).success).toBe(true);
    expect(moveSchema.safeParse({ ...base, from: '/a' }).success).toBe(false);
  });

  it('mkdir and delete default to non-recursive', () => {
    const base = { sessionId: crypto.randomUUID(), path: '/a' };
    expect(mkdirSchema.safeParse(base).success).toBe(true);
    expect(deleteSchema.safeParse(base).success).toBe(true);
  });

  it('session create accepts optional name and meta', () => {
    expect(sessionCreateSchema.safeParse({}).success).toBe(true);
    expect(sessionCreateSchema.safeParse({ name: 'agent', meta: { x: 1 } }).success).toBe(true);
    expect(sessionCreateSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('execRunSchema requires a non-empty command', () => {
    const base = { sessionId: crypto.randomUUID() };
    expect(execRunSchema.safeParse({ ...base, command: 'echo hi' }).success).toBe(true);
    expect(execRunSchema.safeParse({ ...base, command: '' }).success).toBe(false);
    expect(execRunSchema.safeParse(base).success).toBe(false);
  });

  it('execRunSchema bounds timeout and allows optional cwd', () => {
    const base = { sessionId: crypto.randomUUID(), command: 'ls' };
    expect(execRunSchema.safeParse({ ...base, timeout: 0 }).success).toBe(false);
    expect(execRunSchema.safeParse({ ...base, timeout: 121000 }).success).toBe(false);
    expect(execRunSchema.safeParse({ ...base, timeout: 5000, cwd: '.' }).success).toBe(true);
  });

  it('execLogSchema paginates and targets one execution', () => {
    const base = { sessionId: crypto.randomUUID() };
    expect(execLogSchema.safeParse(base).success).toBe(true);
    expect(execLogSchema.safeParse({ ...base, execId: crypto.randomUUID() }).success).toBe(true);
    expect(execLogSchema.safeParse({ ...base, limit: 0 }).success).toBe(false);
    expect(execLogSchema.safeParse({ ...base, offset: 2, limit: 50 }).success).toBe(true);
  });
});
