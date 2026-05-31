/**
 * @module expressions/schema
 * Runtime JSON Schema for CDrus expression bundle YAML files.
 *
 * No longer a hand-written grammar copy. The recursive
 * produce/detach/concurrent-branch grammar is owned by the canonical CDrus
 * schema (`schemas/cdrus/expression.schema.json`); the runtime validator is
 * derived from it plus the Iron Monkey overlay (per-event `id`, timing,
 * `subject`, `tool`/`source`/`pipeline`, expression-ref cascade defaults, and
 * loosened event-type pattern) in {@link module:schema/cdrus-grammar}. One
 * source of truth for the grammar prevents the runtime validator from drifting
 * behind the spec.
 *
 * Used by {@link module:expressions/loader} to validate bundles at load.
 */

export { expressionBundleSchema } from '../schema/cdrus-grammar.js';
