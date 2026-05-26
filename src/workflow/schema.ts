/**
 * @module workflow/schema
 * JSON Schema (draft-07) definition for Iron Monkey workflow YAML files.
 * Enforces the Sympraxis paradigm: bus selection is not a workflow concern
 * (no `bus` key), and pipeline stages are expressed as a flat `produces` list
 * rather than a nested `stages` hierarchy. Used by {@link module:workflow/parser}
 * to validate files before resolution.
 *
 * Aligns with the CDrus workflow schema (`schemas/cdrus/workflow.schema.json`):
 * `cdrus` is required, expression references use CDrus path-style identity
 * notation, and event items support the `produces`/`detach` nesting grammar.
 * Iron Monkey extends the CDrus event-item shape with `timeout_ms`,
 * `min_wait_ms`, and `subject` to support timing control and explicit subject
 * seeding without modifying the CDrus grammar.
 */

export const workflowSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['workflow'],
  additionalProperties: false,
  properties: {
    workflow: {
      type: 'object',
      required: ['id', 'name', 'cdrus', 'produces'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        group: {
          type: 'string',
          minLength: 1,
          pattern: '^[a-z][a-z0-9-]*$',
          description:
            'Group component of the workflow identity (mirrors expression bundle authorship).',
        },
        author: {
          type: 'string',
          minLength: 1,
          pattern: '^[a-z][a-z0-9-]*$',
          description:
            'Author component of the workflow identity. Used as the disambiguation context ' +
            'when resolving bare expression names that exist in multiple groups.',
        },
        name: { type: 'string', minLength: 1 },
        cdrus: {
          type: 'object',
          required: ['version'],
          additionalProperties: true,
          properties: {
            version: { type: 'number' },
            metadata: { type: 'object', additionalProperties: true },
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
            // Iron Monkey extension: default subject content merged into every event
            content: { type: 'object', additionalProperties: true },
          },
        },
        produces: {
          type: 'array',
          minItems: 1,
          items: {
            oneOf: [
              {
                // ── Direct event item ──────────────────────────────────────────
                type: 'object',
                required: ['event'],
                additionalProperties: false,
                properties: {
                  event: { type: 'string', minLength: 1 },
                  tool: { type: 'string', minLength: 1 },
                  source: { type: 'string', minLength: 1 },
                  pipeline: { type: 'string', minLength: 1 },
                  content: { type: 'object', additionalProperties: true },
                  // ── CDrus composition grammar ──────────────────────────────
                  produces: {
                    type: 'array',
                    minItems: 1,
                    items: { type: 'object' },
                  },
                  detach: {
                    type: 'array',
                    minItems: 1,
                    items: { type: 'object' },
                  },
                  // ── Iron Monkey extensions ─────────────────────────────────
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
              {
                // ── Expression reference item ──────────────────────────────────
                type: 'object',
                required: ['expression'],
                additionalProperties: false,
                properties: {
                  // CDrus path-style identity: expression | author/expression | group/author/expression
                  expression: {
                    type: 'string',
                    pattern: '^([a-z][a-z0-9-]*/){0,2}[a-z][a-z0-9-]*$',
                  },
                  tool: { type: 'string', minLength: 1 },
                  source: { type: 'string', minLength: 1 },
                  pipeline: { type: 'string', minLength: 1 },
                  // ── Iron Monkey extensions ─────────────────────────────────
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
