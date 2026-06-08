/**
 * @module schema/cdrus-grammar
 * Single source of truth for the CDrus grammar at runtime.
 *
 * The recursive produce/detach/branch grammar is owned by the canonical CDrus
 * JSON Schemas in `schemas/cdrus/` (`workflow.schema.json`,
 * `expression.schema.json`). Rather than hand-maintain a second copy — which
 * silently drifts (the `concurrent_branch` form had to be back-ported by hand
 * once already) — this module LOADS the canonical schemas and applies a small,
 * explicit Iron Monkey OVERLAY:
 *
 *  - **Extensions** IM adds that the language spec deliberately omits:
 *    event-level `subject` seeding and `defaults.content`. Timing
 *    (`timeout_ms` / `min_wait_ms`) is now CANONICAL on the workflow side
 *    (the CDrus workflow schema types it `number` on `event_item`,
 *    `expression_item`, `event_override`, and `defaults`), so the workflow
 *    overlay no longer re-declares it — re-declaring once shadowed canonical's
 *    `number` with `integer` and wrongly rejected fractional values. On the
 *    EXPRESSION-BUNDLE side, where the canonical grammar omits timing, IM still
 *    adds it — as `number`, matching the workflow convention so both schemas
 *    accept the same values.
 *  - **Relaxations** IM needs as a permissive *emitter* (Iron Mike + Chaos
 *    Monkey) of a stricter spec: `group` / `author` optional; event-type
 *    `pattern` and `source` `format: uri` dropped to plain non-empty strings.
 *
 * The recursive structure (`produce_item` = event | expression | concurrent
 * branch, with nested `produces` / `detach`) is taken verbatim from canonical,
 * so it can never fall behind the spec again. Everything IM changes is right
 * here, in one visible diff. `additionalProperties: false` is preserved on the
 * item shapes, so field typos are still rejected.
 *
 * `format` keywords are stripped because the loaders compile with a bare
 * `new Ajv()` (no `ajv-formats`); an undefined `format` would otherwise throw
 * at compile time. `$id` is stripped to avoid cross-compile ref collisions.
 */

import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

/** A mutable JSON-Schema-ish object tree. */
type SchemaObj = Record<string, unknown>;

/** Reads and parses a canonical CDrus schema by base name. */
function readCanonical(name: 'workflow' | 'expression'): SchemaObj {
  // dist/schema/cdrus-grammar.js (or src/schema/…) -> ../../schemas/cdrus
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../schemas/cdrus');
  const raw = readFileSync(join(dir, `${name}.schema.json`), 'utf-8');
  return JSON.parse(raw) as SchemaObj;
}

/** Recursively deletes the given keys everywhere in a schema tree (in place). */
function stripKeys(node: unknown, keys: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((n) => stripKeys(n, keys));
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as SchemaObj;
    for (const k of keys) delete obj[k];
    for (const v of Object.values(obj)) stripKeys(v, keys);
  }
}

/**
 * Timing fields for the EXPRESSION-BUNDLE overlay only. The canonical CDrus
 * workflow schema already defines `timeout_ms` / `min_wait_ms` (as `number`) on
 * its event/expression/override items, so the workflow overlay leaves them
 * alone; the canonical expression grammar omits them, so IM adds them here.
 * Typed `number` (NOT `integer`) so it matches canonical/workflow exactly — an
 * `integer` here would reject fractional millisecond values the workflow side
 * accepts, splitting the two schemas.
 */
const TIMING = {
  timeout_ms: { type: 'number', minimum: 0 },
  min_wait_ms: { type: 'number', minimum: 0 },
};

/** IM subject-seeding extension. */
const SUBJECT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    content: { type: 'object', additionalProperties: true },
  },
};

const LOOSE_STRING = { type: 'string', minLength: 1 };

/** Replaces a property's schema with a loose non-empty string (drops pattern/format). */
function loosen(props: SchemaObj | undefined, key: string): void {
  if (props && props[key]) props[key] = { ...LOOSE_STRING };
}

/**
 * Builds the runtime workflow schema = canonical workflow grammar + IM overlay.
 */
function buildWorkflowSchema(): SchemaObj {
  const s = readCanonical('workflow');
  stripKeys(s, ['$id', 'format']);

  const defs = s.definitions as SchemaObj;
  const wf = (s.properties as SchemaObj).workflow as SchemaObj;

  // Relaxation: group/author are optional for Iron Monkey workflows.
  wf.required = (wf.required as string[]).filter((k) => k !== 'group' && k !== 'author');

  // Extension: defaults may carry `content` (deep-merged into every event).
  const defaults = (wf.properties as SchemaObj).defaults as SchemaObj;
  const defaultsProps = defaults.properties as SchemaObj;
  defaultsProps.content = { type: 'object', additionalProperties: true };
  loosen(defaultsProps, 'source');

  // event_item: timing + `as` are canonical (number / string in the CDrus
  // workflow schema); IM only adds `subject` seeding and loosens event/source.
  const eventItem = defs.event_item as SchemaObj;
  const evProps = eventItem.properties as SchemaObj;
  Object.assign(evProps, { subject: { ...SUBJECT } });
  loosen(evProps, 'event');
  loosen(evProps, 'source');

  // expression_item: timing is canonical; IM only loosens source.
  const exprItem = defs.expression_item as SchemaObj;
  const exProps = exprItem.properties as SchemaObj;
  loosen(exProps, 'source');

  // event_override: timing is canonical; IM only loosens source.
  const override = defs.event_override as SchemaObj;
  const ovProps = override.properties as SchemaObj;
  loosen(ovProps, 'source');

  return s;
}

/**
 * Builds the runtime expression-bundle schema = canonical expression grammar +
 * IM overlay. Mirrors the workflow overlay; the canonical expression event_item
 * is bare (event / produces / detach), so IM's per-event fields are merged in.
 */
function buildExpressionBundleSchema(): SchemaObj {
  const s = readCanonical('expression');
  stripKeys(s, ['$id', 'format']);

  const defs = s.definitions as SchemaObj;

  // event_item: + id + timing + subject + tool/source/pipeline; loosen event.
  const eventItem = defs.event_item as SchemaObj;
  const evProps = eventItem.properties as SchemaObj;
  Object.assign(evProps, {
    id: { type: 'string', minLength: 1 },
    ...TIMING,
    subject: { ...SUBJECT },
    tool: { ...LOOSE_STRING },
    source: { ...LOOSE_STRING },
    pipeline: { ...LOOSE_STRING },
  });
  loosen(evProps, 'event');

  // expression_item: canonical allows only `expression`; IM adds defaults that
  // cascade onto the inlined sub-expression's events.
  const exprItem = defs.expression_item as SchemaObj;
  const exProps = exprItem.properties as SchemaObj;
  Object.assign(exProps, {
    tool: { ...LOOSE_STRING },
    source: { ...LOOSE_STRING },
    pipeline: { ...LOOSE_STRING },
    ...TIMING,
  });

  return s;
}

/** Runtime workflow schema (canonical grammar + Iron Monkey overlay). */
export const workflowSchema = buildWorkflowSchema();

/** Runtime expression-bundle schema (canonical grammar + Iron Monkey overlay). */
export const expressionBundleSchema = buildExpressionBundleSchema();
