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

/**
 * Connection settings for the Junction Box HTTP bus. Junction Box exposes a
 * REST API that mirrors the role of an AMQP broker — `POST /api/runs/register` activates a
 * workflow run and returns a `runId` that becomes the Proleptic chainId, and
 * `/api/events` accepts each individual CDEvent (responding 202 on accept).
 * This adapter is the Iron Monkey counterpart of the `fire-sequence.zsh`
 * reference script.
 */
export interface JunctionBoxBusConfig {
  /** Discriminant field identifying this as a Junction Box config. */
  type: 'junction-box';
  /** Base URL of the Junction Box service, e.g. `http://localhost:3000`. */
  url: string;
  /**
   * Workflow ID to activate via `POST /api/runs/register` on connect. When omitted,
   * the bus skips the launch step and relies on the workflow being pre-active
   * (or on an externally-supplied chainId).
   */
  workflow_id?: string;
  /** When `false`, skips the `GET /health` preflight. Default `true`. */
  health_check?: boolean;
  /**
   * When `false`, skips the `POST /api/runs/register` step even when `workflow_id`
   * is set. Default `true`.
   */
  launch?: boolean;
  /** Path used for individual event POSTs. Default `/api/events`. */
  events_path?: string;
  /**
   * HTTP status code expected from the events endpoint on successful publish.
   * Default `202`.
   */
  expected_status?: number;
  /** Extra headers to attach to every request (e.g. authorization tokens). */
  headers?: Record<string, string>;
}

/** Union of supported bus connection configs. */
export type BusConfig = RabbitMQBusConfig | KafkaBusConfig | JunctionBoxBusConfig;

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
  /**
   * Base URL of the connector line — the same door a person opens in a
   * browser, e.g. `http://localhost:8080`. There is no tool-specific port: if
   * a person can reach the console, a tool can reach the line.
   */
  url: string;
  /** Bearer token for authenticating with Conduit (optional if unauthenticated). */
  token?: string;
  /**
   * The identity this producer asks under, e.g. `iron-monkey`, `jenkins-prod`.
   * The handshake is refused without it, and a run is keyed
   * `tool + ":" + execution` — so a drifting identity opens runs that no later
   * inquiry can address. Defaults to {@link DEFAULT_CONDUIT_TOOL}.
   */
  tool?: string;
}

/** The identity Iron Monkey asks under when the config does not name one. */
export const DEFAULT_CONDUIT_TOOL = 'iron-monkey';

/** Fully merged Iron Monkey runtime configuration. */
export interface IronMonkeyConfig {
  /** Optional Conduit service used to acquire Proleptic chain IDs. */
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
  /** Where `catalog:<id>` references are resolved from. */
  catalog?: {
    /** Catalog directory; overridden by --catalog and IRON_MONKEY_CATALOG. */
    dir?: string;
  };
  /**
   * Producer bindings applied to events that name no tool and no source.
   *
   * A catalog authored for the AUTHORITY declares coordinates, not emitters —
   * it has no reason to say which Jenkins produced a build. A producer must
   * put a real `source` on the wire (the CDEvents schema requires a non-empty
   * one), so these fill that in WITHOUT editing the document. That is what
   * keeps a mirrored catalog byte-identical to canonical: the producer
   * identity lives in the producer's config, where it belongs.
   */
  defaults?: {
    /** Tool identifier used when an event names none; looked up in `tools`. */
    tool?: string;
    /** `source` URI used when neither the event nor `tools` supplies one. */
    source?: string;
  };
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
