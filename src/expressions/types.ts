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
