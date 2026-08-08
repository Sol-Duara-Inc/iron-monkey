/**
 * @module workflow/schema
 * Runtime JSON Schema + compiled validator for Iron Monkey workflow YAML.
 *
 * The recursive produces/spawn/detach grammar is owned by the canonical CDrus
 * 0.1.0 schema (`schemas/cdrus/workflow.schema.json`); the runtime schema is
 * derived from it plus the Iron Monkey overlay in
 * {@link module:schema/cdrus-grammar}. The COMPILED validator is exported from
 * here so production ({@link module:workflow/parser}) and the schema tests
 * exercise the exact same AJV instance — no per-consumer compilation drift.
 */

import { createAjv2020 } from '../util/ajv.js';
import { workflowSchema } from '../schema/cdrus-grammar.js';

export { workflowSchema } from '../schema/cdrus-grammar.js';

/** The one compiled workflow validator shared by production and tests. */
export const validateWorkflowDoc = createAjv2020().compile(workflowSchema);
