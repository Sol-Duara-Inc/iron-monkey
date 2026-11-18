import { describe, it, expect } from 'vitest';
import { synthesize, type SynthContext } from '../../src/synth/synthesizer.js';
import { loadSchemas, validateEvent } from '../../src/schema/validator.js';

const baseCtx: SynthContext = {
  toolSource: 'https://jenkins.example.com/',
  chainId: 'chain-fixed-1',
  eventType: 'dev.cdevents.testsuiterun.finished.0.3.0',
  workflowName: 'demo-workflow',
  subjectId: 'subject-1',
  timestamp: '2026-05-08T00:00:00.000Z',
};

/** Wrap a content sub-schema in the full CDEvent shape the synthesizer expects. */
function wrap(contentSchema: unknown) {
  return {
    type: 'object',
    properties: {
      subject: {
        type: 'object',
        properties: { content: contentSchema },
      },
    },
  };
}

describe('synthesize', () => {
  it('returns user content unchanged when no schema is provided', () => {
    const result = synthesize({ keep: 'me' }, undefined, baseCtx);
    expect(result.content).toEqual({ keep: 'me' });
    expect(result.synthesized).toEqual([]);
  });

  it('returns user content unchanged when schema has no subject.content', () => {
    const result = synthesize({ keep: 'me' }, { type: 'object' }, baseCtx);
    expect(result.content).toEqual({ keep: 'me' });
    expect(result.synthesized).toEqual([]);
  });

  it('never overwrites user-supplied values', () => {
    const schema = wrap({
      type: 'object',
      required: ['outcome'],
      properties: { outcome: { type: 'string', enum: ['success', 'failure'] } },
    });
    const result = synthesize({ outcome: 'failure' }, schema, baseCtx);
    expect(result.content.outcome).toBe('failure');
    expect(result.synthesized).toEqual([]);
  });

  it('fills missing required string with semantic generator (outcome → success)', () => {
    const schema = wrap({
      type: 'object',
      required: ['outcome'],
      properties: { outcome: { type: 'string' } },
    });
    const result = synthesize({}, schema, baseCtx);
    expect(result.content.outcome).toBe('success');
    expect(result.synthesized).toContain('/subject/content/outcome');
  });

  it('prefers "success" when present in an enum', () => {
    const schema = wrap({
      type: 'object',
      required: ['outcome'],
      properties: { outcome: { type: 'string', enum: ['failure', 'success', 'cancel'] } },
    });
    expect(synthesize({}, schema, baseCtx).content.outcome).toBe('success');
  });

  it('falls back to the first enum value when "success" is not available', () => {
    const schema = wrap({
      type: 'object',
      required: ['severity'],
      properties: { severity: { type: 'string', enum: ['low', 'medium', 'high'] } },
    });
    expect(synthesize({}, schema, baseCtx).content.severity).toBe('low');
  });

  it('recurses into nested required objects and fills children', () => {
    const schema = wrap({
      type: 'object',
      required: ['environment'],
      properties: {
        environment: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    });
    const result = synthesize({}, schema, baseCtx);
    expect(result.content.environment).toBeDefined();
    expect((result.content.environment as { id: string }).id).toMatch(/^synth-environment-/);
    expect(result.synthesized).toContain('/subject/content/environment');
    expect(result.synthesized).toContain('/subject/content/environment/id');
  });

  it('completes a partially-supplied nested object instead of replacing it', () => {
    const schema = wrap({
      type: 'object',
      properties: {
        environment: {
          type: 'object',
          required: ['id', 'source'],
          properties: {
            id: { type: 'string' },
            source: { type: 'string', format: 'uri-reference' },
          },
        },
      },
      required: ['environment'],
    });
    const result = synthesize({ environment: { source: 'https://my.tool/' } }, schema, baseCtx);
    const env = result.content.environment as { id: string; source: string };
    expect(env.source).toBe('https://my.tool/'); // preserved
    expect(env.id).toMatch(/^synth-environment-/); // synthesized
    expect(result.synthesized).toContain('/subject/content/environment/id');
    expect(result.synthesized).not.toContain('/subject/content/environment/source');
  });

  it('uses the tool source as the base for URI-format fields', () => {
    const schema = wrap({
      type: 'object',
      required: ['uri'],
      properties: { uri: { type: 'string', format: 'uri' } },
    });
    const result = synthesize({}, schema, baseCtx);
    expect(result.content.uri).toMatch(/^https:\/\/jenkins\.example\.com\/synth\/uri\//);
  });

  it('falls back to a synthetic absolute URI when the tool source is relative', () => {
    const schema = wrap({
      type: 'object',
      required: ['uri'],
      properties: { uri: { type: 'string', format: 'uri' } },
    });
    const result = synthesize({}, schema, { ...baseCtx, toolSource: 'dev/spinnaker' });
    expect(result.content.uri).toMatch(/^https:\/\/[a-z0-9-]+\.synth\.iron-monkey\.local\//);
  });

  it('fills date-time fields with the ctx timestamp', () => {
    const schema = wrap({
      type: 'object',
      required: ['when'],
      properties: { when: { type: 'string', format: 'date-time' } },
    });
    const result = synthesize({}, schema, baseCtx);
    expect(result.content.when).toBe(baseCtx.timestamp);
  });

  it('produces a uuid-shaped string for format: uuid', () => {
    const schema = wrap({
      type: 'object',
      required: ['rid'],
      properties: { rid: { type: 'string', format: 'uuid' } },
    });
    const result = synthesize({}, schema, baseCtx);
    expect(result.content.rid).toMatch(
      /^[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}$/,
    );
  });

  it('respects schema.minimum for integer fields, defaults to 1 otherwise', () => {
    const schema = wrap({
      type: 'object',
      required: ['count', 'rank'],
      properties: {
        count: { type: 'integer' },
        rank: { type: 'integer', minimum: 42 },
      },
    });
    const result = synthesize({}, schema, baseCtx);
    expect(result.content.count).toBe(1);
    expect(result.content.rank).toBe(42);
  });

  it('returns false for missing required boolean', () => {
    const schema = wrap({
      type: 'object',
      required: ['ok'],
      properties: { ok: { type: 'boolean' } },
    });
    expect(synthesize({}, schema, baseCtx).content.ok).toBe(false);
  });

  it('returns an empty array for required arrays without minItems', () => {
    const schema = wrap({
      type: 'object',
      required: ['tags'],
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    });
    expect(synthesize({}, schema, baseCtx).content.tags).toEqual([]);
  });

  it('emits the required minItems for arrays with a lower bound', () => {
    const schema = wrap({
      type: 'object',
      required: ['parts'],
      properties: {
        parts: { type: 'array', minItems: 2, items: { type: 'string' } },
      },
    });
    const result = synthesize({}, schema, baseCtx);
    expect(Array.isArray(result.content.parts)).toBe(true);
    expect((result.content.parts as unknown[]).length).toBe(2);
  });

  it('uses the workflow name for the pipelineName generator', () => {
    const schema = wrap({
      type: 'object',
      required: ['pipelineName'],
      properties: { pipelineName: { type: 'string' } },
    });
    expect(synthesize({}, schema, baseCtx).content.pipelineName).toBe('demo-workflow');
  });

  it('emits a pURL-shaped artifactId derived from the workflow name', () => {
    const schema = wrap({
      type: 'object',
      required: ['artifactId'],
      properties: { artifactId: { type: 'string' } },
    });
    const result = synthesize({}, schema, baseCtx);
    expect(result.content.artifactId).toBe('pkg:oci/demo-workflow@1.0.0');
  });

  it('echoes the tool source for "source" fields and empty string for "errors"', () => {
    const schema = wrap({
      type: 'object',
      required: ['source', 'errors'],
      properties: { source: { type: 'string' }, errors: { type: 'string' } },
    });
    const result = synthesize({}, schema, baseCtx);
    expect(result.content.source).toBe(baseCtx.toolSource);
    expect(result.content.errors).toBe('');
  });

  it('is deterministic for a given (chainId, eventType, pointer)', () => {
    const schema = wrap({
      type: 'object',
      required: ['environment'],
      properties: {
        environment: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    });
    const a = synthesize({}, schema, baseCtx);
    const b = synthesize({}, schema, baseCtx);
    expect(a.content).toEqual(b.content);
  });

  it('produces different synthesized values for different chainIds', () => {
    const schema = wrap({
      type: 'object',
      required: ['environment'],
      properties: {
        environment: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    });
    const a = synthesize({}, schema, baseCtx);
    const b = synthesize({}, schema, { ...baseCtx, chainId: 'chain-fixed-2' });
    expect((a.content.environment as { id: string }).id).not.toBe(
      (b.content.environment as { id: string }).id,
    );
  });
});

describe('synthesize — non-commons event types fill every declared field', () => {
  // A layered (non-`dev.cdevents.*`) type: Conduit obliges the full declared
  // field set, so the synthesizer must fill every declared property, not just
  // the schema's `required`.
  const layeredCtx: SynthContext = {
    ...baseCtx,
    eventType: 'com.saronis.platform.svc.change.merged.0.1.0',
  };

  // 1. Fills every declared field for a non-commons type (the core regression).
  it('fills every declared field, not just required ones', () => {
    const schema = wrap({
      type: 'object',
      properties: { repository: { type: 'object' }, reviewer: { type: 'string' } },
      required: [],
    });
    const result = synthesize(undefined, schema, layeredCtx);
    expect('repository' in result.content).toBe(true);
    expect('reviewer' in result.content).toBe(true);
    const pairs = Object.keys(result.content.repository as Record<string, unknown>).map(
      (key) => `/subject/content/repository/${key}`,
    );
    expect(result.synthesized).toEqual([
      ...pairs,
      '/subject/content/repository',
      '/subject/content/reviewer',
    ]);
  });

  // 2. An object field with no declared properties carries three pairs.
  it('fills an object field with no declared properties with a string, a number and a boolean', () => {
    const schema = wrap({
      type: 'object',
      properties: { repository: { type: 'object' }, reviewer: { type: 'string' } },
      required: [],
    });
    const result = synthesize(undefined, schema, layeredCtx);
    const repository = result.content.repository as Record<string, unknown>;
    const keys = Object.keys(repository);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toMatch(/^text-[0-9a-z]{6}$/);
    expect(keys[1]).toMatch(/^number-[0-9a-z]{6}$/);
    expect(keys[2]).toMatch(/^flag-[0-9a-z]{6}$/);
    expect(repository[keys[0]]).toMatch(/^synth-repository-[0-9a-z]{6}$/);
    expect(typeof repository[keys[1]]).toBe('number');
    expect(Number.isFinite(repository[keys[1]])).toBe(true);
    expect(typeof repository[keys[2]]).toBe('boolean');
  });

  // 3. A declared-but-unrequired field stays absent for a commons type.
  it('leaves a declared-but-unrequired commons field absent', () => {
    const schema = wrap({
      type: 'object',
      properties: { outcome: { type: 'string' }, severity: { type: 'string' } },
      required: ['outcome'],
    });
    const result = synthesize({}, schema, baseCtx); // baseCtx is a dev.cdevents.* type
    expect(typeof result.content.outcome).toBe('string');
    expect((result.content.outcome as string).length).toBeGreaterThan(0);
    expect('severity' in result.content).toBe(false);
  });

  // 4. Nested objects follow their own `required`, not `properties`, even under
  //    a non-commons top-level type.
  it('completes nested objects against required, not properties', () => {
    const schema = wrap({
      type: 'object',
      properties: {
        env: {
          type: 'object',
          properties: { id: { type: 'string' }, source: { type: 'string' } },
          required: ['id'],
        },
      },
      required: [],
    });
    const result = synthesize({ env: {} }, schema, layeredCtx);
    const env = result.content.env as Record<string, unknown>;
    expect(typeof env.id).toBe('string');
    expect((env.id as string).length).toBeGreaterThan(0);
    expect('source' in env).toBe(false);
  });

  // 5. Determinism on the non-commons branch.
  it('is deterministic across identical calls on the non-commons branch', () => {
    const schema = wrap({
      type: 'object',
      properties: { repository: { type: 'object' }, reviewer: { type: 'string' } },
      required: [],
    });
    const a = synthesize(undefined, schema, layeredCtx);
    const b = synthesize(undefined, schema, layeredCtx);
    expect(a.content).toEqual(b.content);
    expect(a.synthesized).toEqual(b.synthesized);
  });

  // 6 & 7. `undefined` and `{}` user content behave identically.
  it('treats undefined and {} user content identically on the non-commons branch', () => {
    const schema = wrap({
      type: 'object',
      properties: { repository: { type: 'object' }, reviewer: { type: 'string' } },
      required: [],
    });
    const fromUndefined = synthesize(undefined, schema, layeredCtx);
    const fromEmpty = synthesize({}, schema, layeredCtx);
    expect('repository' in fromUndefined.content).toBe(true);
    expect('reviewer' in fromUndefined.content).toBe(true);
    expect(fromEmpty.content).toEqual(fromUndefined.content);
    expect(fromEmpty.synthesized).toEqual(fromUndefined.synthesized);
  });

  // 8. `properties: {}` adds nothing — on either branch.
  it('adds nothing when the content schema declares no properties (both branches)', () => {
    const schema = wrap({ type: 'object', properties: {}, required: [] });
    for (const ctx of [baseCtx, layeredCtx]) {
      const result = synthesize({ keep: 'me' }, schema, ctx);
      expect(result.content).toEqual({ keep: 'me' });
      expect(result.synthesized).toEqual([]);
    }
  });

  // 9. A content schema that is `{type:'object'}` with no `properties` key.
  it('returns user content unchanged for a bare {type:object} content schema', () => {
    const schema = wrap({ type: 'object' });
    const result = synthesize({ keep: 'me' }, schema, layeredCtx);
    expect(result.content).toEqual({ keep: 'me' });
    expect(result.synthesized).toEqual([]);
  });

  // 10. A full schema with no subject.content — early return still applies.
  it('returns user content unchanged when there is no subject.content (non-commons)', () => {
    const result = synthesize({ keep: 'me' }, { type: 'object' }, layeredCtx);
    expect(result.content).toEqual({ keep: 'me' });
    expect(result.synthesized).toEqual([]);
  });

  // 11. Caller-supplied falsy values survive on the non-commons branch.
  it('never overwrites caller-supplied falsy values on the non-commons branch', () => {
    const schema = wrap({
      type: 'object',
      properties: { repository: { type: 'object' }, reviewer: { type: 'string' } },
      required: [],
    });
    const result = synthesize({ reviewer: '', repository: null }, schema, layeredCtx);
    expect(result.content.reviewer).toBe('');
    expect(result.content.repository).toBe(null);
    expect(result.synthesized).toEqual([]);
  });

  // 12. An empty-string eventType takes the non-commons branch.
  it('treats an empty-string eventType as non-commons and fills every field', () => {
    const schema = wrap({
      type: 'object',
      properties: { repository: { type: 'object' }, reviewer: { type: 'string' } },
      required: [],
    });
    const result = synthesize({}, schema, { ...baseCtx, eventType: '' });
    expect('repository' in result.content).toBe(true);
    expect('reviewer' in result.content).toBe(true);
  });

  // 13. `dev.cdevents.` exactly takes the commons branch.
  it('treats eventType "dev.cdevents." exactly as the commons branch', () => {
    const schema = wrap({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: [],
    });
    const result = synthesize({}, schema, { ...baseCtx, eventType: 'dev.cdevents.' });
    expect('a' in result.content).toBe(false);
    expect(result.synthesized).toEqual([]);
  });
});

describe('synthesize — integration with real CDEvent schemas', () => {
  it('produces schema-valid content for testsuiterun.finished from an empty input', async () => {
    const schemas = await loadSchemas();
    const schema = schemas.get('dev.cdevents.testsuiterun.finished.0.3.0');
    expect(schema).toBeDefined();

    const result = synthesize({}, schema, baseCtx);
    const payload = {
      context: {
        specversion: '0.6.0-draft',
        id: '11111111-1111-4111-8111-111111111111',
        source: baseCtx.toolSource,
        type: baseCtx.eventType,
        timestamp: baseCtx.timestamp,
        chainId: baseCtx.chainId,
      },
      subject: { id: baseCtx.subjectId, content: result.content },
    };
    const verdict = validateEvent(payload, schema);
    expect(verdict.valid).toBe(true);
    expect(result.synthesized).toContain('/subject/content/outcome');
    expect(result.synthesized).toContain('/subject/content/environment');
  });

  it('produces schema-valid content for service.deployed from an empty input', async () => {
    const schemas = await loadSchemas();
    const eventType = 'dev.cdevents.service.deployed.0.3.0';
    const schema = schemas.get(eventType);
    expect(schema).toBeDefined();

    const result = synthesize({}, schema, { ...baseCtx, eventType });
    const payload = {
      context: {
        specversion: '0.6.0-draft',
        id: '22222222-2222-4222-8222-222222222222',
        source: baseCtx.toolSource,
        type: eventType,
        timestamp: baseCtx.timestamp,
        chainId: baseCtx.chainId,
      },
      subject: { id: baseCtx.subjectId, content: result.content },
    };
    expect(validateEvent(payload, schema).valid).toBe(true);
  });

  // Unit-level proxy for the executed Conduit proof: a layered com.saronis type
  // must carry every declared field and remain schema-valid. Fails before the
  // non-commons branch exists (synthesize would return `{}`).
  it('fills every declared field for a layered com.saronis type and stays schema-valid', async () => {
    const schemas = await loadSchemas();
    const eventType = 'com.saronis.platform.svc.change.merged.0.1.0';
    const schema = schemas.get(eventType);
    expect(schema).toBeDefined();

    const result = synthesize({}, schema, { ...baseCtx, eventType });
    const payload = {
      context: {
        specversion: '0.6.0-draft',
        id: '33333333-3333-4333-8333-333333333333',
        source: baseCtx.toolSource,
        type: eventType,
        timestamp: baseCtx.timestamp,
        chainId: baseCtx.chainId,
      },
      subject: { id: baseCtx.subjectId, content: result.content },
    };
    expect(validateEvent(payload, schema).valid).toBe(true);
    expect('repository' in result.content && 'reviewer' in result.content).toBe(true);
  });
});

describe('synthesize — no synthesized object is sent empty', () => {
  // Iron Monkey stands in for the platform engineer, whose objects carry data:
  // an empty object is read differently from one with data.
  const layeredCtx: SynthContext = {
    ...baseCtx,
    eventType: 'com.saronis.platform.svc.service.deployed.0.1.0',
  };
  const openObject = wrap({
    type: 'object',
    properties: { environment: { type: 'object' } },
    required: [],
  });

  it('derives the pairs from the chain, the type and the pointer', () => {
    const a = synthesize(undefined, openObject, layeredCtx);
    const b = synthesize(undefined, openObject, layeredCtx);
    expect(a.content).toEqual(b.content);
    const other = synthesize(undefined, openObject, { ...layeredCtx, chainId: 'chain-fixed-2' });
    expect(Object.keys(other.content.environment as object)).not.toEqual(
      Object.keys(a.content.environment as object),
    );
  });

  it('chooses an integer or a float for the number', () => {
    const numbers: number[] = [];
    for (let i = 0; i < 40; i++) {
      const result = synthesize(undefined, openObject, { ...layeredCtx, chainId: `chain-${i}` });
      const environment = result.content.environment as Record<string, unknown>;
      numbers.push(environment[Object.keys(environment)[1]] as number);
    }
    expect(numbers.every((n) => Number.isFinite(n))).toBe(true);
    expect(numbers.some((n) => Number.isInteger(n))).toBe(true);
    expect(numbers.some((n) => !Number.isInteger(n))).toBe(true);
  });

  it('records each pair as synthesized', () => {
    const result = synthesize(undefined, openObject, layeredCtx);
    for (const key of Object.keys(result.content.environment as object)) {
      expect(result.synthesized).toContain(`/subject/content/environment/${key}`);
    }
    expect(result.synthesized).toContain('/subject/content/environment');
  });

  it('fills every declared member of an object that requires none', () => {
    const schema = wrap({
      type: 'object',
      properties: {
        trigger: {
          type: 'object',
          properties: { type: { type: 'string' }, uri: { type: 'string', format: 'uri' } },
        },
      },
      required: [],
    });
    const result = synthesize(undefined, schema, layeredCtx);
    const trigger = result.content.trigger as Record<string, unknown>;
    expect(Object.keys(trigger)).toEqual(['type', 'uri']);
    expect(trigger.type).toMatch(/^synth-type-/);
    expect(trigger.uri).toMatch(/^https:\/\/jenkins\.example\.com\/synth\/uri\//);
    expect(result.synthesized).toContain('/subject/content/trigger/type');
    expect(result.synthesized).toContain('/subject/content/trigger/uri');
  });

  it('keeps {} for an object whose schema declares no member and forbids any other key', () => {
    const schema = wrap({
      type: 'object',
      properties: { sealed: { type: 'object', additionalProperties: false } },
      required: [],
    });
    const result = synthesize(undefined, schema, layeredCtx);
    expect(result.content.sealed).toEqual({});
  });

  it('never fills an object the workflow supplied, even an empty one', () => {
    const result = synthesize({ environment: {} }, openObject, layeredCtx);
    expect(result.content.environment).toEqual({});
    expect(result.synthesized).toEqual([]);
  });

  it('fills a member-less object nested inside a required object', () => {
    const schema = wrap({
      type: 'object',
      required: ['environment'],
      properties: {
        environment: {
          type: 'object',
          required: ['labels'],
          properties: { labels: { type: 'object' } },
        },
      },
    });
    const result = synthesize({}, schema, baseCtx); // a commons type
    const labels = (result.content.environment as Record<string, unknown>).labels as Record<
      string,
      unknown
    >;
    expect(Object.keys(labels)).toHaveLength(3);
    expect(Object.values(labels).map((v) => typeof v)).toEqual(['string', 'number', 'boolean']);
  });

  it('sends no empty object below the content, and stays valid, for every shipped schema', async () => {
    const schemas = await loadSchemas();
    const empties: string[] = [];
    const find = (value: unknown, pointer: string, type: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, i) => find(item, `${pointer}/${i}`, type));
        return;
      }
      if (value === null || typeof value !== 'object') return;
      const keys = Object.keys(value);
      if (keys.length === 0 && pointer !== '/subject/content') empties.push(`${type} ${pointer}`);
      for (const key of keys)
        find((value as Record<string, unknown>)[key], `${pointer}/${key}`, type);
    };
    for (const [eventType, schema] of schemas) {
      const result = synthesize({}, schema, { ...baseCtx, eventType });
      find(result.content, '/subject/content', eventType);
      const payload = {
        context: {
          specversion: '0.6.0-draft',
          id: '44444444-4444-4444-8444-444444444444',
          source: baseCtx.toolSource,
          type: eventType,
          timestamp: baseCtx.timestamp,
          chainId: baseCtx.chainId,
        },
        subject: { id: baseCtx.subjectId, content: result.content },
      };
      expect(validateEvent(payload, schema).valid, eventType).toBe(true);
    }
    expect(empties).toEqual([]);
  });
});
