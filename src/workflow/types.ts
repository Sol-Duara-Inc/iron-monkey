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
 * CDrus expression bundle by path-style identity; the bundle is expanded into
 * one or more CDEvent entries by {@link resolveProduces}. Item-level fields and
 * `overrides` allow fine-grained customisation without forking the bundle.
 */
export interface ExpressionItem {
  /**
   * Expression bundle reference in path-style CDrus identity notation:
   * `'build'` (expression name only), `'iron-monkey/build'` (author/expression),
   * or `'sol-duara/iron-monkey/build'` (group/author/expression).
   * Resolved against the expression registry at parse time.
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
  /**
   * CDrus grammar block. Required per the CDrus workflow schema. Contains the
   * schema version this workflow targets and optional free-form metadata.
   */
  cdrus: {
    /** CDrus schema version this workflow YAML targets (e.g. `1`). */
    version: number;
    /** Optional documentation metadata (description, owner, tags). */
    metadata?: WorkflowMetadata;
  };
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
