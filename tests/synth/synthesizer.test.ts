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
});
