import { describe, expect, it } from 'vitest';
import { main, run } from './worker.js';

describe('worker entry', () => {
  it('exports main function', () => {
    expect(typeof main).toBe('function');
  });

  it('exports run function', () => {
    expect(typeof run).toBe('function');
  });
});
