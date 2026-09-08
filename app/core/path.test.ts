import { PathError } from '@mycomputer/shared';
import { describe, expect, it } from 'vitest';
import { basename, isStrictSubpath, isSubpathOrEqual, normalizePath, parentOf } from './path.js';

describe('normalizePath', () => {
  it('normalizes duplicate and trailing slashes', () => {
    expect(normalizePath('/a//b/')).toBe('/a/b');
    expect(normalizePath('///')).toBe('/');
  });

  it('rejects traversal and relative paths', () => {
    for (const bad of ['..', '../etc', '/a/../b', '/a/./b', 'a/b', '']) {
      expect(() => normalizePath(bad), bad).toThrow(PathError);
    }
  });

  it('rejects control bytes and oversized paths', () => {
    expect(() => normalizePath('/a\0b')).toThrow(PathError);
    expect(() => normalizePath('/'.repeat(5000))).toThrow(PathError);
  });
});

describe('path helpers', () => {
  it('computes parents and basenames', () => {
    expect(parentOf('/a/b/c.txt')).toBe('/a/b');
    expect(parentOf('/a')).toBe('/');
    expect(parentOf('/')).toBe(null);
    expect(basename('/a/b/c.txt')).toBe('c.txt');
    expect(basename('/')).toBe('');
  });

  it('detects subpath relationships', () => {
    expect(isSubpathOrEqual('/a/b', '/a')).toBe(true);
    expect(isSubpathOrEqual('/a', '/a')).toBe(true);
    expect(isSubpathOrEqual('/ab', '/a')).toBe(false);
    expect(isStrictSubpath('/a', '/a')).toBe(false);
    expect(isStrictSubpath('/a/b', '/a')).toBe(true);
  });
});
