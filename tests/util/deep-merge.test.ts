import { describe, it, expect } from 'vitest';
import { deepMerge } from '../../src/util/deep-merge.js';

describe('deepMerge', () => {
  it('overlays top-level scalars (override wins)', () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('recursively merges nested objects rather than replacing them', () => {
    expect(deepMerge({ x: { a: 1, b: 2 } }, { x: { b: 3, c: 4 } })).toEqual({
      x: { a: 1, b: 3, c: 4 },
    });
  });

  it('replaces arrays wholesale (does not element-merge)', () => {
    expect(deepMerge({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] });
  });

  it('ignores undefined override values (keeps base)', () => {
    expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });

  it('overwrites an object with a primitive when override is a primitive', () => {
    expect(deepMerge({ a: { nested: true } }, { a: 5 })).toEqual({ a: 5 });
  });

  it('does not mutate either input', () => {
    const base = { a: { b: 1 } };
    const override = { a: { c: 2 } };
    deepMerge(base, override);
    expect(base).toEqual({ a: { b: 1 } });
    expect(override).toEqual({ a: { c: 2 } });
  });
});
