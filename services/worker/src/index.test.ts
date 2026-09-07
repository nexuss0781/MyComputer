import { describe, expect, it } from 'vitest';
import { main } from './index.js';

describe('worker entry', () => {
  it('exposes a main entry point', () => {
    expect(typeof main).toBe('function');
  });
});
