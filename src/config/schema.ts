/**
 * @module config/schema
 * JSON Schema (draft-07) definition for `iron-monkey.yaml` / `iron-monkey.json`.
 * Used by {@link module:config/loader} to validate config files before merging
 * them with environment-variable and CLI-override layers.
 *
 * Top-level keys: `conduit`, `buses`, `tools`.  The `buses` map accepts named
 * entries that are either RabbitMQ or Kafka connection configs.
 */

export const configSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  properties: {
    conduit: {
      type: 'object',
      required: ['url'],
      additionalProperties: false,
      properties: {
        url: { type: 'string', format: 'uri' },
        token: { type: 'string' },
      },
    },
    buses: {
      type: 'object',
      additionalProperties: {
        oneOf: [
          {
            type: 'object',
            required: ['type', 'url'],
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['rabbitmq'] },
              url: { type: 'string' },
              auth: {
                type: 'object',
                required: ['username', 'password'],
                additionalProperties: false,
                properties: {
                  username: { type: 'string' },
                  password: { type: 'string' },
                },
              },
              exchange: { type: 'string' },
              routing_key_template: { type: 'string' },
            },
          },
          {
            type: 'object',
            required: ['type', 'brokers'],
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['kafka'] },
              brokers: { type: 'array', items: { type: 'string' }, minItems: 1 },
              topic: { type: 'string' },
            },
          },
        ],
      },
    },
    tools: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['source'],
        additionalProperties: false,
        properties: {
          source: { type: 'string' },
        },
      },
    },
  },
};
