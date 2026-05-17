import { describe, it, expect } from 'vitest';
import { isEventItem, isExpressionItem } from '../src/types.js';

describe('isEventItem', () => {
  it('returns true for an object with an event key', () => {
    expect(isEventItem({ event: 'dev.cdevents.build.started.0.5.1' })).toBe(true);
  });

  it('returns false for an object with an expression key', () => {
    expect(isEventItem({ expression: 'build' })).toBe(false);
  });
});

describe('isExpressionItem', () => {
  it('returns true for an object with an expression key', () => {
    expect(isExpressionItem({ expression: 'build' })).toBe(true);
  });

  it('returns false for an object with an event key', () => {
    expect(isExpressionItem({ event: 'dev.cdevents.build.started.0.5.1' })).toBe(false);
  });
});
