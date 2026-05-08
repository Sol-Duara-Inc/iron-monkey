/**
 * @module workflow/schema
 * JSON Schema (draft-07) definition for Iron Monkey workflow YAML files.
 * Enforces the Sympraxis paradigm: bus selection is not a workflow concern
 * (no `bus` key), and pipeline stages are expressed as a flat `produces` list
 * rather than a nested `stages` hierarchy. Used by {@link module:workflow/parser}
 * to validate files before resolution.
 *
 * Top-level key: `workflow` containing `id`, `name`, `version`, optional
 * `metadata` and `defaults`, and a non-empty `produces` array.
 */

export const workflowSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['workflow'],
  additionalProperties: false,
  properties: {
    workflow: {
      type: 'object',
      required: ['id', 'name', 'version', 'produces'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        version: { type: 'integer', minimum: 1 },
        metadata: {
          type: 'object',
          additionalProperties: true,
          properties: {
            description: { type: 'string' },
            owner: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
        defaults: {
          type: 'object',
          additionalProperties: true,
          properties: {
            timeout_ms: { type: 'integer', minimum: 0 },
            min_wait_ms: { type: 'integer', minimum: 0 },
            pipeline: { type: 'string' },
            tool: { type: 'string' },
            source: { type: 'string' },
            content: { type: 'object', additionalProperties: true },
          },
        },
        produces: {
          type: 'array',
          minItems: 1,
          items: {
            oneOf: [
              {
                type: 'object',
                required: ['event'],
                additionalProperties: false,
                properties: {
                  event: { type: 'string', minLength: 1 },
                  tool: { type: 'string', minLength: 1 },
                  source: { type: 'string', minLength: 1 },
                  pipeline: { type: 'string', minLength: 1 },
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
                  content: { type: 'object', additionalProperties: true },
                },
              },
              {
                type: 'object',
                required: ['expression'],
                additionalProperties: false,
                properties: {
                  expression: { type: 'string', pattern: '^[a-zA-Z0-9_-]+:.+$' },
                  tool: { type: 'string', minLength: 1 },
                  source: { type: 'string', minLength: 1 },
                  pipeline: { type: 'string', minLength: 1 },
                  timeout_ms: { type: 'integer', minimum: 0 },
                  min_wait_ms: { type: 'integer', minimum: 0 },
                  overrides: {
                    type: 'object',
                    additionalProperties: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        tool: { type: 'string', minLength: 1 },
                        source: { type: 'string', minLength: 1 },
                        timeout_ms: { type: 'integer', minimum: 0 },
                        min_wait_ms: { type: 'integer', minimum: 0 },
                        content: { type: 'object', additionalProperties: true },
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  },
};
