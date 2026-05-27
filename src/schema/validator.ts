/**
 * @module schema/validator
 * Loads CDEvent JSON schemas and validates event payloads using AJV 2020-12.
 * An `embeddedlinksarray` schema is registered to satisfy `$ref` lookups from
 * official CDEvent schemas while allowing Iron Monkey's simplified
 * `{ type, target }` link shape rather than the full 0.5.1 specification.
 */

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { loadSchemasFromDir, getDefaultSchemasDir } from '../loaders/schema.loader.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvConstructor = (Ajv2020 as any).default ?? Ajv2020;
const ajv = new AjvConstructor({ allErrors: true, strict: false });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormatsFunc = (addFormats as any).default ?? addFormats;
addFormatsFunc(ajv);

// The CDEvent schemas reference this via $ref; define it here so AJV resolves
// it. Iron Monkey emits links in the CDEvents 0.6.0 embedded-link shape — a
// discriminated union by `linkType`, with per-type fields. `START` is never
// embedded (it's a stand-alone link only); only `PATH`, `END`, and `RELATION`
// are accepted here. Spec: https://github.com/cdevents/spec/blob/main/links.md
ajv.addSchema({
  $id: 'https://cdevents.dev/0.5.1/schema/links/embeddedlinksarray',
  type: 'array',
  items: {
    oneOf: [
      {
        // PATH — points back to the previous event.
        type: 'object',
        required: ['linkType', 'from'],
        additionalProperties: false,
        properties: {
          linkType: { type: 'string', const: 'PATH' },
          from: {
            type: 'object',
            required: ['contextId'],
            additionalProperties: false,
            properties: { contextId: { type: 'string', minLength: 1 } },
          },
        },
      },
      {
        // END — marks the carrying event as the chain's terminator.
        type: 'object',
        required: ['linkType', 'end'],
        additionalProperties: false,
        properties: {
          linkType: { type: 'string', const: 'END' },
          end: {
            type: 'object',
            required: ['contextId'],
            additionalProperties: false,
            properties: { contextId: { type: 'string', minLength: 1 } },
          },
        },
      },
      {
        // RELATION — discriminated by `linkKind`, points at the related event.
        type: 'object',
        required: ['linkType', 'linkKind', 'target'],
        additionalProperties: false,
        properties: {
          linkType: { type: 'string', const: 'RELATION' },
          linkKind: { type: 'string', minLength: 1 },
          target: {
            type: 'object',
            required: ['contextId'],
            additionalProperties: false,
            properties: { contextId: { type: 'string', minLength: 1 } },
          },
        },
      },
    ],
  },
});

/**
 * Loads all CDEvent JSON schemas from the given directory (or the bundled
 * default) and returns them indexed by event type string.
 *
 * @param schemasPath - Optional path to a custom schemas directory. Falls back
 *   to the bundled `schemas/cdevents/` directory when not provided.
 * @returns A `Map<string, unknown>` from CDEvent type string to raw schema object.
 */
export async function loadSchemas(schemasPath?: string): Promise<Map<string, unknown>> {
  const dir = schemasPath ?? (await getDefaultSchemasDir());
  return loadSchemasFromDir(dir);
}

/** Result of a CDEvent payload validation pass. */
export interface ValidationResult {
  /** `true` if the payload satisfies the schema, `false` otherwise. */
  valid: boolean;
  /**
   * Human-readable error messages when `valid` is `false`. Each entry
   * describes the instance path and constraint that was violated.
   */
  errors?: string[];
}

/**
 * Validates a CDEvent payload against the provided JSON schema using AJV
 * 2020-12. Compiles and caches the schema on first use (keyed by `$id` when
 * present) for efficient repeated calls.
 *
 * @param payload - The CDEvent payload object to validate.
 * @param schema - The raw JSON schema object for this event type.
 * @returns A {@link ValidationResult} indicating success or listing errors.
 */
export function validateEvent(payload: unknown, schema: unknown): ValidationResult {
  const s = schema as { $id?: string };
  const validate = s.$id && ajv.getSchema(s.$id) ? ajv.getSchema(s.$id)! : ajv.compile(s);
  const valid = validate(payload);
  if (!valid) {
    const errors =
      validate.errors?.map(
        (e: { instancePath: string; message?: string }) =>
          `  ${e.instancePath || '(root)'}: ${e.message}`,
      ) ?? [];
    return { valid: false, errors };
  }
  return { valid: true };
}
