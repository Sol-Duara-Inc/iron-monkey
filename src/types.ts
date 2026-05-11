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

/**
 * @module manifest/types
 * Core data types for the Iron Monkey event manifest. The manifest is a
 * pre-allocated, serialisable snapshot of every CDEvent that a workflow run
 * will emit, including timing, chain-link wiring, and (post-injection) failure
 * annotations.
 */

/**
 * A single CDEvents link embedded in `context.links`. Links wire events into
 * a directed Sympraxis chain so consumers can reconstruct causal order.
 */
export interface LinkEntry {
  /**
   * Semantic role of this link:
   * - `PATH` — the target is the immediately preceding event.
   * - `START` — the target is the first event in the chain.
   * - `END` — the target is the last substantive event before the chain-end
   *   sentinel.
   * - `RELATION` — a non-sequential reference to a related event.
   */
  type: 'PATH' | 'START' | 'END' | 'RELATION';
  /** The `context.id` (UUID) of the linked CDEvent. */
  target: string;
}

/**
 * An audit record attached to a manifest event after a failure injection has
 * been applied. Allows post-run analysis to distinguish natural events from
 * deliberately corrupted or suppressed ones.
 */
export interface InjectionRecord {
  /** Injection category (e.g. `'missing'`, `'malformed'`, `'late'`). */
  type: string;
  /** The original injection spec string for traceability. */
  spec: string;
  /** Always `true` once the injection has been applied to the event. */
  applied: boolean;
}

/**
 * A single pre-allocated CDEvent entry in the manifest. Combines the resolved
 * workflow metadata, the CDEvent payload, timing, chain membership, and
 * runtime emission state. The emitter mutates `emitStatus`, `actualEmitTime`,
 * and `emitError` in place during a run.
 */
export interface ManifestEvent {
  /** UUID allocated by {@link IdAllocator}; stamped as `context.id` in the payload. */
  eventId: string;
  /**
   * Stable workflow-level identifier (noun-verb slug, e.g. `'build-started'`)
   * used by injections to target specific events by name.
   */
  workflowEventId: string;
  /** Fully-qualified CDEvent type string, e.g. `dev.cdevents.build.started.0.1.0`. */
  type: string;
  /** Pipeline/stage identifier from the workflow `pipeline` field. */
  stageId: string;
  /** Tool identifier from the workflow `tool` field. */
  stageTool: string;
  /**
   * When `true` this event should be emitted in parallel with adjacent events
   * that also have `concurrent: true`.
   */
  concurrent: boolean;
  /** CDEvents `context.source` URI identifying the originating tool. */
  source: string;
  /** The Sympraxis chain ID shared by all events in this run. */
  chainId: string;
  /** Name of the message bus this event is destined for. */
  targetBus: string;
  /**
   * Epoch milliseconds at which this event is scheduled to be emitted.
   * May be increased by a `late` injection.
   */
  targetEmitTime: number;
  /** The fully constructed CDEvent payload, validated against its JSON schema. */
  payload: CDEventPayload;
  /** Injection records applied to this event (empty until injections are run). */
  injections: InjectionRecord[];
  /** `true` for the final event in the manifest, used to emit the chain-end sentinel. */
  isLast: boolean;
  /**
   * Epoch milliseconds recorded when the event was actually published to the bus.
   * Only present after successful emission.
   */
  actualEmitTime?: number;
  /**
   * Emission lifecycle state. Starts as `'pending'`; transitions to `'emitted'`,
   * `'skipped'` (via `missing` injection), or `'error'` if the bus throws.
   */
  emitStatus?: 'pending' | 'emitted' | 'skipped' | 'error';
  /** Error message recorded when `emitStatus` is `'error'`. */
  emitError?: string;
}

/**
 * The `context` block of a CDEvent payload, following the CDEvents 0.5.1
 * specification with Iron Monkey extensions for chain linking.
 */
export interface CDEventContext {
  /** CloudEvents spec version string (e.g. `'0.5.1'`). */
  specversion: string;
  /** Unique UUID for this event instance. */
  id: string;
  /** URI identifying the tool or system that produced the event. */
  source: string;
  /** Fully-qualified CDEvent type string. */
  type: string;
  /** ISO 8601 timestamp of when the event was scheduled for emission. */
  timestamp: string;
  /** Sympraxis chain ID correlating all events in a workflow run. */
  chainId?: string;
  /** Ordered array of link entries connecting this event to others in the chain. */
  links?: LinkEntry[];
  /** Optional URI pointing to the JSON schema for this event type. */
  schemaUri?: string;
}

/**
 * The `subject` block of a CDEvent payload, describing the SDLC artefact or
 * activity that the event is about.
 */
export interface CDEventSubject {
  /** Identifier of the subject (e.g. build ID, pipeline run ID). */
  id: string;
  /** Optional alternative source URI for the subject when different from the event source. */
  source?: string;
  /** Structured subject content whose shape is defined by the event type schema. */
  content: Record<string, unknown>;
}

/**
 * The complete CDEvent payload as emitted on the message bus. Combines the
 * {@link CDEventContext} and {@link CDEventSubject} blocks per the CDEvents
 * specification.
 */
export interface CDEventPayload {
  /** Event metadata including id, type, source, timestamp, and chain link wiring. */
  context: CDEventContext;
  /** Description of the SDLC artefact or activity the event pertains to. */
  subject: CDEventSubject;
}

/**
 * The top-level manifest produced by {@link buildManifest}. Captures all run
 * metadata and the ordered, pre-allocated sequence of events to be emitted.
 */
export interface Manifest {
  /** UUID uniquely identifying this manifest (and the Iron Monkey run). */
  runId: string;
  /** The workflow `id` field from the YAML. */
  workflowId: string;
  /** The workflow `name` field from the YAML. */
  workflowName: string;
  /** The Sympraxis chain ID shared across all events in this run. */
  chainId: string;
  /** Indicates whether `chainId` was issued by Conduit or generated locally. */
  chainIdSource: 'conduit' | 'fallback';
  /** ISO 8601 timestamp of when the manifest was built. */
  createdAt: string;
  /** Ordered list of CDEvents to emit, with timing and chain-link wiring resolved. */
  events: ManifestEvent[];
}

/**
 * @module workflow/types
 * TypeScript types for Iron Monkey workflow YAML files. A workflow describes an
 * SDLC orchestration scenario: which CDEvents (or expression bundles) to produce,
 * in what order, with what default timing and tool attribution. Workflows are
 * parsed and resolved by {@link module:workflow/parser}.
 */

/** Optional freeform metadata attached to a workflow for documentation purposes. */
export interface WorkflowMetadata {
  /** Human-readable description of what this workflow simulates. */
  description?: string;
  /** Team or individual responsible for maintaining this workflow definition. */
  owner?: string;
  /** Arbitrary classification tags for filtering or catalogue lookup. */
  tags?: string[];
  /** Any additional metadata fields not covered by the standard properties. */
  [key: string]: unknown;
}

/**
 * Workflow-level defaults that apply to every `produces` item unless overridden
 * at the item or expression-override level.
 */
export interface WorkflowDefaults {
  /**
   * Default upper timing bound in milliseconds for inter-event delays.
   * Applied when an event or expression item does not specify its own
   * `timeout_ms`. Defaults to `5000` when absent.
   */
  timeout_ms?: number;
  /**
   * Default lower timing bound in milliseconds for inter-event delays.
   * Applied when an event or expression item does not specify its own
   * `min_wait_ms`. Defaults to `100` when absent.
   */
  min_wait_ms?: number;
  /** Default pipeline/stage name stamped on every resolved event's `stageId`. */
  pipeline?: string;
  /** Default tool identifier looked up in the config `tools` map for source URI resolution. */
  tool?: string;
  /** Default CDEvents `source` URI applied when no item-level source is specified. */
  source?: string;
  /**
   * Default subject `content` fields deep-merged into every event's subject.
   * More specific content (item-level or override-level) takes precedence.
   */
  content?: Record<string, unknown>;
}

/**
 * A direct CDEvent produce item in the workflow `produces` list. Specifies a
 * single CDEvent type to emit, with optional tool attribution, timing, and
 * subject content that override workflow-level defaults.
 */
export interface EventItem {
  /** Fully-qualified CDEvent type string, e.g. `dev.cdevents.build.started.0.1.0`. */
  event: string;
  /** Tool identifier overriding the workflow default for this event. */
  tool?: string;
  /** CDEvents `source` URI overriding the workflow default for this event. */
  source?: string;
  /** Pipeline name overriding the workflow default for this event. */
  pipeline?: string;
  /** Maximum inter-event delay in ms, overriding the workflow default. */
  timeout_ms?: number;
  /** Minimum inter-event delay in ms, overriding the workflow default. */
  min_wait_ms?: number;
  /** Explicit subject identity and content for this event. */
  subject?: {
    /** Subject ID; defaults to the auto-assigned `workflowEventId` when absent. */
    id?: string;
    /** Subject content fields merged on top of the workflow `defaults.content`. */
    content?: Record<string, unknown>;
  };
  /**
   * Shorthand for `subject.content`. Merged with `defaults.content`; takes
   * precedence over `defaults.content` but is superseded by `subject.content`
   * when both are present.
   */
  content?: Record<string, unknown>;
}

/**
 * Per-event overrides applied when expanding an expression bundle. Keyed by
 * the bundle event's `id` field or its `noun.verb` string when `id` is absent.
 * Only the fields specified here are overridden; unspecified fields inherit
 * from the expression item or workflow defaults.
 */
export interface ExpressionOverride {
  /** Tool identifier override for this specific bundle event. */
  tool?: string;
  /** Source URI override for this specific bundle event. */
  source?: string;
  /** Timeout override for this specific bundle event. */
  timeout_ms?: number;
  /** Minimum wait override for this specific bundle event. */
  min_wait_ms?: number;
  /** Subject content fields merged on top of the bundle and workflow defaults. */
  content?: Record<string, unknown>;
}

/**
 * An expression produce item in the workflow `produces` list. References a
 * CDrus expression bundle by name and semver range; the bundle is expanded into
 * one or more CDEvent entries by {@link resolveProduces}. Item-level fields and
 * `overrides` allow fine-grained customisation without forking the bundle.
 */
export interface ExpressionItem {
  /**
   * Expression bundle reference in `<name>:<semver-range>` format, e.g.
   * `'github-actions:^1.0.0'`. Resolved against the expression registry at
   * parse time.
   */
  expression: string;
  /** Default tool identifier for all events expanded from this expression. */
  tool?: string;
  /** Default source URI for all events expanded from this expression. */
  source?: string;
  /** Pipeline name applied to all events expanded from this expression. */
  pipeline?: string;
  /** Default timeout for all events expanded from this expression. */
  timeout_ms?: number;
  /** Default minimum wait for all events expanded from this expression. */
  min_wait_ms?: number;
  /**
   * Per-event overrides keyed by the bundle event's `id` or `noun.verb`.
   * Allows individual events within a bundle to have different tool, source,
   * timing, or content without modifying the bundle itself.
   */
  overrides?: Record<string, ExpressionOverride>;
}

/**
 * Discriminated union of the two produce item forms: a direct CDEvent entry or
 * an expression bundle reference.
 */
export type ProducesItem = EventItem | ExpressionItem;

/** The `workflow` block inside a workflow YAML file. */
export interface WorkflowDef {
  /** Unique stable identifier for this workflow, used in the manifest and chain ID generation. */
  id: string;
  /** Human-readable name displayed in logs and used for fallback chain ID slugs. */
  name: string;
  /** Integer schema version; increment when making breaking changes to the workflow. */
  version: number;
  /** Optional documentation metadata (description, owner, tags). */
  metadata?: WorkflowMetadata;
  /**
   * Default values applied to all `produces` items that do not specify their
   * own values for the same fields.
   */
  defaults?: WorkflowDefaults;
  /** Ordered list of CDEvent and/or expression items to produce during a run. */
  produces: ProducesItem[];
}

/**
 * The top-level structure of a workflow YAML file. The `workflow` key is the
 * single required root key.
 */
export interface WorkflowFile {
  /** The workflow definition. */
  workflow: WorkflowDef;
}

/**
 * Type guard returning `true` when `item` is a direct {@link EventItem}
 * (has an `event` key).
 *
 * @param item - A `ProducesItem` from the workflow `produces` list.
 */
export function isEventItem(item: ProducesItem): item is EventItem {
  return 'event' in item;
}

/**
 * Type guard returning `true` when `item` is an {@link ExpressionItem}
 * (has an `expression` key).
 *
 * @param item - A `ProducesItem` from the workflow `produces` list.
 */
export function isExpressionItem(item: ProducesItem): item is ExpressionItem {
  return 'expression' in item;
}

/**
 * @module expressions/types
 * TypeScript types for CDrus expression bundles. A bundle is a versioned,
 * named collection of CDEvents that an SDLC tool or pipeline stage is expected
 * to produce. Bundles are referenced from workflow `produces` arrays as
 * `expression: '<name>:<semver-range>'` items.
 */

/**
 * A single CDEvent entry within an expression bundle's `produces` list.
 * Declares the expected event type along with optional timing and subject hints
 * that the manifest builder uses when no workflow-level overrides are present.
 */
export interface ExpressionEvent {
  /** Fully-qualified CDEvent type string, e.g. `dev.cdevents.build.started.0.1.0`. */
  event: string;
  /**
   * Optional stable identifier for this event within the bundle. Required when
   * multiple events in the same bundle share the same `noun.verb` (e.g. two
   * `build.started` events for parallel builds). Referenced as override keys in
   * workflow YAML.
   */
  id?: string;
  /**
   * Maximum number of milliseconds the emitter waits before the event is
   * considered overdue. Used as the upper bound for the timing allocation.
   */
  timeout_ms?: number;
  /**
   * Minimum number of milliseconds the emitter waits after the previous event
   * before emitting this one. Used as the lower bound for timing allocation.
   */
  min_wait_ms?: number;
  /** Default CDEvents subject shape contributed by the bundle. */
  subject?: {
    /** Default subject ID; overridden by workflow or manifest allocation when absent. */
    id?: string;
    /** Default subject content fields merged with workflow and override-level content. */
    content?: Record<string, unknown>;
  };
}

/**
 * A CDrus expression bundle: a versioned, named grouping of CDEvents that
 * represents the expected output of a particular SDLC tool or pipeline stage.
 * Bundles are discovered from YAML files and indexed by the expression registry.
 */
export interface ExpressionBundle {
  /** Unique name used to reference this bundle, e.g. `'github-actions'`. */
  name: string;
  /** Semantic version string of the bundle, e.g. `'1.2.0'`. */
  version: string;
  /** Optional human-readable description of what this bundle models. */
  description?: string;
  /** Ordered list of CDEvents this bundle declares the tool will produce. */
  produces: ExpressionEvent[];
}

/**
 * The top-level structure of an expression bundle YAML file. The `expression`
 * key wraps the {@link ExpressionBundle} to allow for future metadata fields at
 * the file level.
 */
export interface ExpressionBundleFile {
  /** The expression bundle declared in this file. */
  expression: ExpressionBundle;
}
