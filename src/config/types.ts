/**
 * @module config/types
 * TypeScript types for the Iron Monkey runtime configuration, covering message
 * bus connections, Conduit service credentials, CDEvents schema paths, and
 * tool-source mappings.
 */

/** Connection settings for a RabbitMQ message bus. */
export interface RabbitMQBusConfig {
  /** Discriminant field identifying this as a RabbitMQ config. */
  type: 'rabbitmq';
  /** AMQP connection URL, e.g. `amqp://localhost:5672`. */
  url: string;
  /** Optional credentials to inject into the connection URL at runtime. */
  auth?: {
    /** AMQP username. */
    username: string;
    /** AMQP password. */
    password: string;
  };
  /** Exchange name to assert and publish to (default: `'cdevents'`). */
  exchange?: string;
  /**
   * Template for the AMQP routing key. Use `{eventType}` as a placeholder
   * that is substituted with the CDEvent type string at emit time.
   * Default: `'{eventType}'`.
   */
  routing_key_template?: string;
}

/** Connection settings for a Kafka message bus. */
export interface KafkaBusConfig {
  /** Discriminant field identifying this as a Kafka config. */
  type: 'kafka';
  /** One or more Kafka broker addresses, e.g. `['localhost:9092']`. */
  brokers: string[];
  /** Kafka topic to publish events to (default varies by implementation). */
  topic?: string;
}

/** Union of supported bus connection configs. */
export type BusConfig = RabbitMQBusConfig | KafkaBusConfig;

/**
 * Configuration for a single SDLC tool whose events Iron Monkey emits.
 * Used to supply a default CDEvents `source` URI when the workflow YAML
 * omits one.
 */
export interface ToolConfig {
  /** CDEvents `source` URI for events originating from this tool. */
  source: string;
}

/** Connection details for the Conduit chain-ID service. */
export interface ConduitConfig {
  /** Base URL of the Conduit service, e.g. `https://conduit.example.com`. */
  url: string;
  /** Bearer token for authenticating with Conduit (optional if unauthenticated). */
  token?: string;
}

/** Fully merged Iron Monkey runtime configuration. */
export interface IronMonkeyConfig {
  /** Optional Conduit service used to acquire Sympraxis chain IDs. */
  conduit?: ConduitConfig;
  /**
   * Named map of message bus configurations. At least one entry is required
   * for event emission. The key `'default'` is used when no explicit bus name
   * is specified.
   */
  buses: Record<string, BusConfig>;
  /**
   * Named map of tool configurations keyed by tool identifier. Values supply
   * default `source` URIs that the manifest builder falls back to when a
   * workflow event does not specify one.
   */
  tools: Record<string, ToolConfig>;
  /**
   * Optional filesystem path to a directory containing CDEvent JSON schemas.
   * Overrides the bundled `schemas/cdevents` directory.
   */
  schemasPath?: string;
}

/** Options controlling how {@link loadConfig} reads and merges configuration. */
export interface LoadConfigOptions {
  /** Explicit path to a config file. Auto-discovered when omitted. */
  configPath?: string;
  /**
   * Values supplied via CLI flags that take highest priority in the merge
   * chain, overriding both file and environment-variable config.
   */
  cliOverrides: Partial<{
    /** Conduit base URL, overrides `conduit.url` from file/env. */
    conduitUrl: string;
    /** Conduit bearer token, overrides `conduit.token` from file/env. */
    conduitToken: string;
    /** Target bus name; selects which entry in `buses` to use. */
    busName: string;
    /** Bus connection URL (env-var shorthand alternative to file config). */
    busUrl: string;
    /** Bus auth username (used together with `busUrl`). */
    busUser: string;
    /** Bus auth password (used together with `busUrl`). */
    busPass: string;
    /** Path to a directory of CDEvent JSON schemas. */
    schemasPath: string;
  }>;
}
