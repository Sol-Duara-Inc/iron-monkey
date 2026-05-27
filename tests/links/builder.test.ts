/**
 * @file tests/links/builder.test.ts
 * Unit tests for the CDEvents-spec-compliant embedded link builders.
 * Spec reference: https://github.com/cdevents/spec/blob/main/links.md
 *
 * `START` links are intentionally not buildable here — per the spec, START
 * is a stand-alone link sent separately and is never embedded.
 */
import { describe, it, expect } from 'vitest';
import { buildPathLink, buildEndLink, buildRelationLink } from '../../src/links/builder.js';

describe('buildPathLink', () => {
  it('returns a CDEvents 0.6.0-shape PATH link with from.contextId', () => {
    const link = buildPathLink('prev-evt-123');
    expect(link).toEqual({
      linkType: 'PATH',
      from: { contextId: 'prev-evt-123' },
    });
  });

  it('does not include any legacy `type` or `target` fields', () => {
    const link = buildPathLink('prev-evt-123') as Record<string, unknown>;
    expect(link.type).toBeUndefined();
    expect(link.target).toBeUndefined();
  });
});

describe('buildEndLink', () => {
  it('returns a CDEvents 0.6.0-shape END link with end.contextId (self-reference)', () => {
    // The argument is the id of the chain-ending event — i.e. the event the
    // link is embedded in. The spec self-references rather than pointing at
    // a separate event.
    const link = buildEndLink('ending-evt-456');
    expect(link).toEqual({
      linkType: 'END',
      end: { contextId: 'ending-evt-456' },
    });
  });

  it('does not include any legacy `type` or `target` fields', () => {
    const link = buildEndLink('ending-evt-456') as Record<string, unknown>;
    expect(link.type).toBeUndefined();
    expect(link.target).toBeUndefined();
  });
});

describe('buildRelationLink', () => {
  it('returns a CDEvents 0.6.0-shape RELATION link with linkKind + target.contextId', () => {
    const link = buildRelationLink('TRIGGER', 'related-evt-789');
    expect(link).toEqual({
      linkType: 'RELATION',
      linkKind: 'TRIGGER',
      target: { contextId: 'related-evt-789' },
    });
  });

  it('passes the supplied linkKind through verbatim', () => {
    expect(buildRelationLink('ARTIFACT', 'evt-1').linkKind).toBe('ARTIFACT');
    expect(buildRelationLink('TRIGGER', 'evt-1').linkKind).toBe('TRIGGER');
  });
});
