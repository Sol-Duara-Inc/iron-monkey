/**
 * @module expressions/schema
 * JSON Schema (draft-07) definition for CDrus expression bundle YAML files.
 * An expression bundle describes a named, versioned set of CDEvents that a
 * particular SDLC tool (or tool combination) is expected to produce. The schema
 * is used by {@link module:expressions/loader} to validate bundles at load time.
 *
 * Top-level key: `expression` containing `name`, `version`, optional
 * `description`, and a `produces` array of CDEvent type entries.
 */

export const expressionBundleSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['expression'],
  additionalProperties: false,
  properties: {
    expression: {
      type: 'object',
      required: ['name', 'version', 'produces'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1 },
        version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
        description: { type: 'string' },
        produces: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['event'],
            additionalProperties: false,
            properties: {
              event: { type: 'string', minLength: 1 },
              id: { type: 'string', minLength: 1 },
              timeout_ms: { type: 'integer', minimum: 0 },
              min_wait_ms: { type: 'integer', minimum: 0 },
              subject: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  content: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
      },
    },
  },
};
