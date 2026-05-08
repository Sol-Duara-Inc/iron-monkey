import { describe, it, expect } from 'vitest';
import { parseInjections } from '../../src/injection/parser.js';

describe('parseInjections', () => {
  it('parses missing injection', () => {
    const result = parseInjections(['missing:build-started']);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'missing', eventId: 'build-started' });
  });

  it('parses malformed injection', () => {
    const result = parseInjections([
      'malformed:testsuiterun-finished:invalid-enum:subject.content.outcome:bogus',
    ]);
    expect(result[0]).toMatchObject({
      type: 'malformed',
      eventId: 'testsuiterun-finished',
      malformation: 'invalid-enum',
      fieldPath: 'subject.content.outcome',
      value: 'bogus',
    });
  });

  it('parses out-of-order injection', () => {
    const result = parseInjections(['out-of-order:artifact-published:2']);
    expect(result[0]).toEqual({
      type: 'out-of-order',
      eventId: 'artifact-published',
      newPosition: 2,
    });
  });

  it('parses late injection', () => {
    const result = parseInjections(['late:deployment-finished:30000']);
    expect(result[0]).toEqual({ type: 'late', eventId: 'deployment-finished', delayMs: 30000 });
  });

  it('parses duplicate injection', () => {
    const result = parseInjections(['duplicate:build-started']);
    expect(result[0]).toEqual({ type: 'duplicate', eventId: 'build-started' });
  });

  it('parses multiple injections', () => {
    const result = parseInjections(['missing:e1', 'late:e2:5000']);
    expect(result).toHaveLength(2);
  });

  it('throws on unknown injection type', () => {
    expect(() => parseInjections(['unknown:event'])).toThrow('Unknown injection type');
  });
});
