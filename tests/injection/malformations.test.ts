import { describe, it, expect } from 'vitest';
import { applyMalformation } from '../../src/injection/malformations.js';

function makePayload(): Record<string, unknown> {
  return {
    context: {
      specversion: '0.5.1',
      id: 'abc-123',
      source: 'https://example.com/',
      type: 'dev.cdevents.build.started.0.5.1',
      timestamp: new Date().toISOString(),
      chainId: 'chain-uuid',
      links: [{ type: 'PATH', target: 'prev-evt-id' }],
    },
    subject: {
      id: 'sub-1',
      content: { outcome: 'success', environment: { id: 'ci-env' } },
    },
  };
}

describe('applyMalformation', () => {
  describe('missing-required-field', () => {
    it('deletes a top-level context field', () => {
      const p = makePayload();
      applyMalformation(p, 'missing-required-field', 'context.id');
      expect((p.context as Record<string, unknown>)['id']).toBeUndefined();
    });

    it('deletes a nested subject field', () => {
      const p = makePayload();
      applyMalformation(p, 'missing-required-field', 'subject.content.outcome');
      expect(
        ((p.subject as Record<string, unknown>)['content'] as Record<string, unknown>)['outcome'],
      ).toBeUndefined();
    });

    it('throws when no fieldPath is given', () => {
      expect(() => applyMalformation(makePayload(), 'missing-required-field')).toThrow(
        'requires a fieldPath',
      );
    });
  });

  describe('wrong-type', () => {
    it('coerces a field to number', () => {
      const p = makePayload();
      applyMalformation(p, 'wrong-type', 'context.specversion', 'number');
      expect((p.context as Record<string, unknown>)['specversion']).toBe(12345);
    });

    it('coerces a field to boolean', () => {
      const p = makePayload();
      applyMalformation(p, 'wrong-type', 'context.specversion', 'boolean');
      expect((p.context as Record<string, unknown>)['specversion']).toBe(true);
    });

    it('coerces a field to null', () => {
      const p = makePayload();
      applyMalformation(p, 'wrong-type', 'context.specversion', 'null');
      expect((p.context as Record<string, unknown>)['specversion']).toBeNull();
    });

    it('coerces a field to array', () => {
      const p = makePayload();
      applyMalformation(p, 'wrong-type', 'context.specversion', 'array');
      expect((p.context as Record<string, unknown>)['specversion']).toEqual([]);
    });

    it('coerces a field to object', () => {
      const p = makePayload();
      applyMalformation(p, 'wrong-type', 'context.specversion', 'object');
      expect((p.context as Record<string, unknown>)['specversion']).toEqual({});
    });

    it('coerces a field to string', () => {
      const p = makePayload();
      applyMalformation(p, 'wrong-type', 'context.specversion', 'string');
      expect(typeof (p.context as Record<string, unknown>)['specversion']).toBe('string');
    });

    it('throws when fieldPath or value is missing', () => {
      expect(() => applyMalformation(makePayload(), 'wrong-type', 'context.id')).toThrow(
        'requires fieldPath and bad-type',
      );
    });
  });

  describe('extra-field', () => {
    it('adds a field that does not exist', () => {
      const p = makePayload();
      applyMalformation(p, 'extra-field', 'context.injectedField', 'bad-value');
      expect((p.context as Record<string, unknown>)['injectedField']).toBe('bad-value');
    });

    it('throws when fieldPath or value is missing', () => {
      expect(() => applyMalformation(makePayload(), 'extra-field', 'context.x')).toThrow(
        'requires fieldPath and value',
      );
    });
  });

  describe('invalid-enum', () => {
    it('sets an out-of-range value on an enum field', () => {
      const p = makePayload();
      applyMalformation(p, 'invalid-enum', 'subject.content.outcome', 'bogus');
      expect(
        ((p.subject as Record<string, unknown>)['content'] as Record<string, unknown>)['outcome'],
      ).toBe('bogus');
    });

    it('throws when fieldPath or value is missing', () => {
      expect(() =>
        applyMalformation(makePayload(), 'invalid-enum', 'subject.content.outcome'),
      ).toThrow('requires fieldPath and bad-value');
    });
  });

  describe('bad-uuid', () => {
    it('replaces the field with an invalid UUID string', () => {
      const p = makePayload();
      applyMalformation(p, 'bad-uuid', 'context.id');
      expect((p.context as Record<string, unknown>)['id']).toBe('not-a-valid-uuid-!!!');
    });

    it('throws when no fieldPath is given', () => {
      expect(() => applyMalformation(makePayload(), 'bad-uuid')).toThrow('requires a fieldPath');
    });
  });

  describe('broken-chainid', () => {
    it('sets chainId to CORRUPTED', () => {
      const p = makePayload();
      applyMalformation(p, 'broken-chainid');
      expect((p.context as Record<string, unknown>)['chainId']).toBe('CORRUPTED');
    });
  });

  describe('unknown malformation', () => {
    it('throws with a descriptive error', () => {
      expect(() => applyMalformation(makePayload(), 'nonexistent-type')).toThrow(
        "Unknown malformation type: 'nonexistent-type'",
      );
    });
  });
});
