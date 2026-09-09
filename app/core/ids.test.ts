import { describe, expect, it } from 'vitest';
import { uuidFromSeed } from './ids.js';

describe('uuidFromSeed', () => {
  it('is deterministic for identical seeds', () => {
    expect(uuidFromSeed('a::b::c')).toBe(uuidFromSeed('a::b::c'));
  });

  it('differs across seeds', () => {
    expect(uuidFromSeed('a::b::c')).not.toBe(uuidFromSeed('a::b::d'));
  });

  it('produces a valid uuid format', () => {
    const u = uuidFromSeed('x');
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
