/**
 * @module expressions/schema
 * Runtime JSON Schema + compiled validator for CDrus expression bundle YAML.
 *
 * The recursive produces/spawn/detach grammar is owned by the canonical CDrus
 * 0.1.0 schema (`schemas/cdrus/expression.schema.json`); the runtime schema is
 * derived from it plus the Iron Monkey overlay (per-event `id`, timing,
 * `subject`, `tool`/`source`/`pipeline`; spec-pure references) in
 * {@link module:schema/cdrus-grammar}. The COMPILED validator is exported from
 * here so production ({@link module:expressions/loader}) and the schema tests
 * exercise the exact same AJV instance — no per-consumer compilation drift.
 */

import { createAjv2020 } from '../util/ajv.js';
import { expressionBundleSchema } from '../schema/cdrus-grammar.js';

export { expressionBundleSchema } from '../schema/cdrus-grammar.js';

/** The one compiled bundle validator shared by production and tests. */
export const validateBundleDoc = createAjv2020().compile(expressionBundleSchema);
