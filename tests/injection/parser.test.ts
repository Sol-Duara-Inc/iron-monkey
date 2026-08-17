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

describe('malformed specs are refused, not silently mangled', () => {
  // Injection specs are hand-typed on the command line, so a typo is the
  // single most likely bad input Iron Monkey sees. Every one of these used to
  // be an untested throw branch: a spec that half-parsed would target the
  // wrong event, or no event, and the run would proceed as if nothing were
  // wrong — the worst outcome for a chaos tool, because the operator would
  // believe they injected a failure they did not.
  it.each([
    ['missing', 'missing'],
    ['duplicate', 'duplicate'],
    ['abort', 'abort'],
    ['out-of-order:evt', 'out-of-order'],
    ['out-of-order', 'out-of-order'],
    ['late:evt', 'late'],
    ['late', 'late'],
    ['malformed:evt', 'malformed'],
    ['malformed', 'malformed'],
  ])('rejects %o (missing required parts)', (spec, type) => {
    expect(() => parseInjections([spec])).toThrow(new RegExp(`Invalid ${type} injection`));
  });

  it('rejects a non-numeric position rather than silently using NaN', () => {
    expect(() => parseInjections(['out-of-order:build-started:soon'])).toThrow(
      /Invalid position in out-of-order injection/,
    );
  });

  it('rejects a non-numeric delay rather than silently using NaN', () => {
    // A NaN delay would make the event's target time NaN, which sorts and
    // schedules unpredictably instead of failing.
    expect(() => parseInjections(['late:build-started:soonish'])).toThrow(
      /Invalid delay in late injection/,
    );
  });

  it('names the valid types when the type itself is unknown', () => {
    expect(() => parseInjections(['destroy:build-started'])).toThrow(
      /Unknown injection type: 'destroy'.*missing, malformed, out-of-order, late, duplicate, abort/s,
    );
  });

  it('rejects an empty spec', () => {
    expect(() => parseInjections([''])).toThrow(/Unknown injection type/);
  });

  it('rejects the bad spec even when good ones precede it', () => {
    // Fail the whole batch: applying half an operator's intent is worse than
    // refusing it, because the run would look like the requested scenario.
    expect(() => parseInjections(['missing:build-started', 'late:build-finished'])).toThrow(
      /Invalid late injection/,
    );
  });

  it('keeps a colon-bearing abort reason intact', () => {
    expect(parseInjections(['abort:build-finished:disk full: /var'])[0]).toMatchObject({
      type: 'abort',
      eventId: 'build-finished',
      reason: 'disk full: /var',
    });
  });
});
