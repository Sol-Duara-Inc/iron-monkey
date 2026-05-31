/**
 * @module workflow/schema
 * Runtime JSON Schema for Iron Monkey workflow YAML files.
 *
 * This is no longer a hand-written copy of the grammar. The recursive
 * produce/detach/concurrent-branch grammar is owned by the canonical CDrus
 * schema (`schemas/cdrus/workflow.schema.json`); the runtime validator is
 * derived from it plus a small Iron Monkey overlay (timing/subject extensions,
 * optional group/author, loosened event/source patterns) in
 * {@link module:schema/cdrus-grammar}. Keeping one source of truth for the
 * grammar prevents the silent drift that previously left the runtime validator
 * rejecting valid spec features (e.g. concurrent branches).
 *
 * Used by {@link module:workflow/parser} to validate files before resolution.
 */

export { workflowSchema } from '../schema/cdrus-grammar.js';
