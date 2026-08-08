/**
 * @module schema/cdrus-grammar
 * Single source of truth for the CDrus grammar at runtime.
 *
 * The recursive produces/spawn/detach grammar is owned by the canonical CDrus
 * 0.1.0 JSON Schemas in `schemas/cdrus/` (`workflow.schema.json`,
 * `expression.schema.json`, JSON Schema 2020-12). Rather than hand-maintain a
 * second copy — which silently drifts — this module LOADS the canonical schemas
 * and applies a small, explicit Iron Monkey OVERLAY:
 *
 *  - **Extensions** IM adds that the language spec deliberately omits:
 *    event-level `subject` seeding, `defaults.content`, and (expression-bundle
 *    side only) per-event `id` / timing / tool / source / pipeline. Timing is
 *    canonical on the workflow side.
 *  - **Relaxations** IM needs as a permissive *emitter* of a stricter spec:
 *    `group` / `author` optional on workflows; `source` `format: uri` dropped
 *    to a plain non-empty string.
 *
 * Two deliberate NON-relaxations (changed at CDrus 0.1.0 adoption):
 *
 *  - The `event` type **pattern is enforced** (core + `dev.cdeventsx.*`
 *    extended forms, embedded/colon/range/versionless versions). Malformed
 *    types now fail at validation instead of surfacing later at manifest
 *    build. Purpose-built malformation still happens downstream via
 *    `--inject` — never by authoring invalid YAML.
 *  - Expression-bundle `expression_item` is **spec-pure** (`expression` only,
 *    `additionalProperties: false`): tool binding belongs to the Workflow
 *    layer (RFC §5.5). Workflow-side expression references keep their
 *    canonical binding fields (tool/source/pipeline/timing/overrides).
 *
 * The recursive structure (chain_item = event | expression reference, with
 * nested `produces` and the flat-or-nested `spawn` / `detach` spawned-chain
 * forms) is taken verbatim from canonical, so it can never fall behind the
 * spec. Everything IM changes is right here, in one visible diff.
 *
 * `format` keywords are stripped because the CDrus loaders compile without
 * `ajv-formats`; `$id` is stripped to avoid cross-compile ref collisions.
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
 * its event/expression/override items; the canonical expression grammar omits
 * them, so IM adds them here. Typed `number` (NOT `integer`) so both schemas
 * accept the same values.
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
 * Builds the runtime workflow schema = canonical 0.1.0 workflow grammar + IM
 * overlay.
 */
function buildWorkflowSchema(): SchemaObj {
  const s = readCanonical('workflow');
  stripKeys(s, ['$id', 'format']);

  const defs = s.$defs as SchemaObj;
  const wf = (s.properties as SchemaObj).workflow as SchemaObj;

  // Relaxation: group/author are optional for Iron Monkey workflows.
  wf.required = (wf.required as string[]).filter((k) => k !== 'group' && k !== 'author');

  // Extension: defaults may carry `content` (deep-merged into every event).
  const defaults = (wf.properties as SchemaObj).defaults as SchemaObj;
  const defaultsProps = defaults.properties as SchemaObj;
  defaultsProps.content = { type: 'object', additionalProperties: true };
  loosen(defaultsProps, 'source');

  // event_item: timing + `as` + the event pattern are canonical; IM adds
  // `subject` seeding and loosens source. The event pattern is KEPT.
  const eventItem = defs.event_item as SchemaObj;
  const evProps = eventItem.properties as SchemaObj;
  Object.assign(evProps, { subject: { ...SUBJECT } });
  loosen(evProps, 'source');

  // expression_item: binding fields are canonical; IM only loosens source.
  const exprItem = defs.expression_item as SchemaObj;
  const exProps = exprItem.properties as SchemaObj;
  loosen(exProps, 'source');

  // event_override: canonical (incl. pipeline at 0.1.0); IM only loosens source.
  const override = defs.event_override as SchemaObj;
  const ovProps = override.properties as SchemaObj;
  loosen(ovProps, 'source');

  return s;
}

/**
 * Builds the runtime expression-bundle schema = canonical 0.1.0 expression
 * grammar + IM overlay. The canonical event_item is bare (event /
 * event_schema_uri / as / produces / spawn / detach), so IM's per-event fields
 * are merged in. `expression_item` is left spec-pure — references carry no
 * binding; binding belongs to the Workflow layer.
 */
function buildExpressionBundleSchema(): SchemaObj {
  const s = readCanonical('expression');
  stripKeys(s, ['$id', 'format']);

  const defs = s.$defs as SchemaObj;

  // event_item: + id + timing + subject + tool/source/pipeline. The event
  // pattern is KEPT (core + extended forms).
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

  return s;
}

/** Runtime workflow schema (canonical grammar + Iron Monkey overlay). */
export const workflowSchema = buildWorkflowSchema();

/** Runtime expression-bundle schema (canonical grammar + Iron Monkey overlay). */
export const expressionBundleSchema = buildExpressionBundleSchema();
