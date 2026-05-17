/**
 * @module expressions/schema
 * JSON Schema (draft-07) definition for CDrus expression bundle YAML files.
 * An expression bundle declares a named SDLC intent by listing the CDEvents
 * that together fulfil that intent, bound to an identity tuple
 * (group, author, expression). The schema is used by
 * {@link module:expressions/loader} to validate bundles at load time.
 *
 * Top-level keys: `group`, `author`, `expression`, optional `description`,
 * and a non-empty `produces` array.  Iron Monkey extends the CDrus event-item
 * shape with `id`, `timeout_ms`, `min_wait_ms`, `subject`, `tool`, `source`,
 * and `pipeline` to support timing control and tool attribution without
 * modifying the expression bundle's CDrus identity.
 */

export const expressionBundleSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['group', 'author', 'expression', 'produces'],
  additionalProperties: false,
  properties: {
    group: {
      type: 'string',
      minLength: 1,
      pattern: '^[a-z][a-z0-9-]*$',
      description: 'Group component of the expression identity tuple.',
    },
    author: {
      type: 'string',
      minLength: 1,
      pattern: '^[a-z][a-z0-9-]*$',
      description: 'Author component of the expression identity tuple.',
    },
    expression: {
      type: 'string',
      minLength: 1,
      pattern: '^[a-z][a-z0-9-]*$',
      description: 'Expression name component of the identity tuple.',
    },
    description: {
      type: 'string',
      description: 'Human-readable description of the intent this expression captures.',
    },
    produces: {
      type: 'array',
      minItems: 1,
      description: 'Ordered list of CDEvents this expression declares.',
      items: {
        type: 'object',
        required: ['event'],
        additionalProperties: false,
        properties: {
          event: {
            type: 'string',
            minLength: 1,
            description: 'Fully-qualified CDEvent type string.',
          },
          // ── Iron Monkey extensions (not in the CDrus expression schema) ──────
          id: {
            type: 'string',
            minLength: 1,
            description:
              'Stable identifier for collision disambiguation when the same noun.verb ' +
              'appears more than once in the bundle.',
          },
          timeout_ms: {
            type: 'integer',
            minimum: 0,
            description: 'Upper timing bound (ms) for inter-event delay.',
          },
          min_wait_ms: {
            type: 'integer',
            minimum: 0,
            description: 'Lower timing bound (ms) for inter-event delay.',
          },
          subject: {
            type: 'object',
            additionalProperties: false,
            description: 'Default subject shape contributed by the bundle.',
            properties: {
              id: { type: 'string' },
              content: { type: 'object', additionalProperties: true },
            },
          },
          tool: {
            type: 'string',
            minLength: 1,
            description: 'Default tool identifier for this event.',
          },
          source: {
            type: 'string',
            minLength: 1,
            description: 'Default CDEvents source URI for this event.',
          },
          pipeline: {
            type: 'string',
            minLength: 1,
            description: 'Default pipeline name for this event.',
          },
        },
      },
    },
  },
};
