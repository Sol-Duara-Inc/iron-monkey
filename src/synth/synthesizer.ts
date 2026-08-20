/**
 * @module synth/synthesizer
 * Fills in schema-required `subject.content` fields that the workflow or
 * expression bundle did not supply. Iron Monkey's bundles describe the
 * *shape* of a happy path; the schemas describe the *contract*; this module
 * is the bridge that produces fully-populated, schema-valid CDEvent payloads
 * without requiring authors to hand-code every leaf.
 *
 * Rules:
 * - User-supplied values are never overwritten (workflow/bundle wins).
 * - Only fields marked `required` by the schema are synthesized; optional
 *   fields stay absent unless the user supplied them.
 * - Synthesis is deterministic for a given `chainId + eventType + JSON pointer`
 *   so repeat runs with the same seed produce the same payloads.
 */

export interface SynthContext {
  /** CDEvents `context.source` URI of the emitting tool — used to derive URIs and source fields. */
  toolSource: string;
  /** Proleptic chain ID — used as the seed input for deterministic short-hashes. */
  chainId: string;
  /** Fully-qualified CDEvent type string. */
  eventType: string;
  /** Workflow name, used for fields like `pipelineName` and `artifactId`. */
  workflowName: string;
  /** The event's `subject.id`, available for context-dependent generators. */
  subjectId: string;
  /** ISO 8601 timestamp the event will be emitted at — used for date-time formats. */
  timestamp: string;
}

export interface SynthResult {
  /** The merged content: user-supplied values plus any synthesized required fields. */
  content: Record<string, unknown>;
  /**
   * JSON pointers (relative to the event payload root) of every leaf that was
   * synthesized. Empty array when the user supplied everything required.
   */
  synthesized: string[];
}

interface JSONSchema {
  type?: string | string[];
  enum?: unknown[];
  format?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  minimum?: number;
  minItems?: number;
  minLength?: number;
}

/**
 * Synthesize missing required `subject.content` fields against the event's
 * JSON schema. Returns a new content object — does not mutate input.
 *
 * @param userContent - Whatever `subject.content` the workflow/expression resolved to.
 * @param fullSchema - The full CDEvent JSON schema (the same object used by the validator).
 * @param ctx - Generation context (tool source, chain id, etc.).
 */
export function synthesize(
  userContent: Record<string, unknown> | undefined,
  fullSchema: unknown,
  ctx: SynthContext,
): SynthResult {
  const synthesized: string[] = [];
  const contentSchema = findContentSchema(fullSchema);
  if (!contentSchema) {
    return { content: userContent ?? {}, synthesized };
  }
  const filled = walkObject(userContent, contentSchema, '/subject/content', ctx, synthesized);
  return { content: filled, synthesized };
}

function findContentSchema(schema: unknown): JSONSchema | undefined {
  const s = schema as {
    properties?: { subject?: { properties?: { content?: JSONSchema } } };
  };
  return s?.properties?.subject?.properties?.content;
}

function walkObject(
  current: Record<string, unknown> | undefined,
  schema: JSONSchema,
  pointer: string,
  ctx: SynthContext,
  synthesized: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(current ?? {}) };
  const props = schema.properties ?? {};
  const required = schema.required ?? [];

  // Recurse into already-present object properties so partials get completed
  // (e.g. user supplied `{environment: {source: '...'}}` but schema requires
  // `environment.id`).
  for (const [key, val] of Object.entries(out)) {
    const sub = props[key];
    if (
      sub &&
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      (sub.type === 'object' || sub.properties)
    ) {
      out[key] = walkObject(
        val as Record<string, unknown>,
        sub,
        `${pointer}/${key}`,
        ctx,
        synthesized,
      );
    }
  }

  for (const key of required) {
    if (out[key] !== undefined) continue;
    const sub = props[key];
    if (!sub) continue;
    const childPointer = `${pointer}/${key}`;
    out[key] = generate(sub, key, childPointer, ctx, synthesized);
    synthesized.push(childPointer);
  }

  return out;
}

function generate(
  schema: JSONSchema,
  fieldName: string,
  pointer: string,
  ctx: SynthContext,
  synthesized: string[],
): unknown {
  if (schema.enum && schema.enum.length > 0) {
    // Prefer 'success' for outcome-like enums; otherwise the first declared value.
    const preferSuccess = schema.enum.find((v) => v === 'success');
    return preferSuccess ?? schema.enum[0];
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case 'object':
      return walkObject({}, schema, pointer, ctx, synthesized);
    case 'array': {
      const min = schema.minItems ?? 0;
      if (min === 0 || !schema.items) return [];
      const arr: unknown[] = [];
      for (let i = 0; i < min; i++) {
        arr.push(generate(schema.items, `${fieldName}-item`, `${pointer}/${i}`, ctx, synthesized));
      }
      return arr;
    }
    case 'integer':
    case 'number':
      return schema.minimum ?? 1;
    case 'boolean':
      return false;
    case 'string':
    default:
      return generateString(schema, fieldName, pointer, ctx);
  }
}

function generateString(
  schema: JSONSchema,
  fieldName: string,
  pointer: string,
  ctx: SynthContext,
): string {
  const lower = fieldName.toLowerCase();

  // Semantic generators keyed by field name. These exist to make synthesized
  // payloads look like a plausible SDLC chain (matching the shape that
  // junction-box's fire-sequence.zsh hand-codes) rather than gibberish.
  switch (lower) {
    case 'outcome':
      return 'success';
    case 'errors':
      return '';
    case 'pipelinename':
      return ctx.workflowName;
    case 'taskname':
      return `${nounFromType(ctx.eventType)}-task`;
    case 'artifactid':
      return `pkg:oci/${slugify(ctx.workflowName)}@1.0.0`;
    case 'source':
      return ctx.toolSource;
  }

  if (schema.format === 'uri' || schema.format === 'uri-reference') {
    const base = absoluteBase(ctx.toolSource);
    return `${base}/synth/${slugify(fieldName)}/${shortHash(ctx, pointer)}`;
  }
  if (schema.format === 'date-time') return ctx.timestamp;
  if (schema.format === 'uuid') return uuidLike(ctx, pointer);

  // `id` is generic — derive a label from the parent path so e.g.
  // /subject/content/environment/id becomes "synth-environment-<hash>".
  if (lower === 'id') {
    const parts = pointer.split('/').filter(Boolean);
    const parent = parts.length >= 2 ? parts[parts.length - 2] : 'subject';
    return `synth-${slugify(parent)}-${shortHash(ctx, pointer)}`;
  }

  return `synth-${slugify(fieldName)}-${shortHash(ctx, pointer)}`;
}

/**
 * Returns an absolute URI base derived from a configured tool source. Tool
 * sources may be configured as relative paths (e.g. `dev/jenkins`) for routing
 * purposes; for URI-format schema fields the synthesizer needs a scheme.
 */
function absoluteBase(toolSource: string): string {
  const trimmed = toolSource.replace(/\/$/, '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  const slug = slugify(trimmed) || 'tool';
  return `https://${slug}.synth.iron-monkey.local`;
}

function nounFromType(type: string): string {
  // dev.cdevents.taskrun.started.0.3.0 → "taskrun"
  const parts = type.split('.');
  const idx = parts.indexOf('cdevents');
  return idx >= 0 && parts[idx + 1] ? parts[idx + 1] : 'event';
}

function slugify(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** FNV-1a 32-bit, base36, 6 chars. Deterministic per (chainId, eventType, pointer). */
function shortHash(ctx: SynthContext, suffix: string): string {
  const s = `${ctx.chainId}|${ctx.eventType}|${suffix}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(6, '0').slice(0, 6);
}

function uuidLike(ctx: SynthContext, pointer: string): string {
  const a = shortHash(ctx, pointer + '/a')
    .padEnd(8, '0')
    .slice(0, 8);
  const b = shortHash(ctx, pointer + '/b')
    .padEnd(4, '0')
    .slice(0, 4);
  const c = shortHash(ctx, pointer + '/c')
    .padEnd(4, '0')
    .slice(0, 4);
  const d = shortHash(ctx, pointer + '/d')
    .padEnd(4, '0')
    .slice(0, 4);
  const e = shortHash(ctx, pointer + '/e')
    .padEnd(12, '0')
    .slice(0, 12);
  return `${a}-${b}-${c}-${d}-${e}`;
}
