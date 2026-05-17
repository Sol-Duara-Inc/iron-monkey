/**
 * @module expressions/types
 * TypeScript types for CDrus expression bundles. A bundle declares a named
 * SDLC intent — build, deploy, verify, and so on — by listing the CDEvents
 * that together fulfil that intent. Every bundle is bound to an identity tuple:
 * (group, author, expression). Bundles are referenced from workflow `produces`
 * arrays using path-style notation: `expression`, `author/expression`, or
 * `group/author/expression`.
 */

/**
 * A single CDEvent entry within an expression bundle's `produces` list.
 * Declares the expected event type along with optional Iron Monkey timing and
 * subject hints that the manifest builder uses when no workflow-level overrides
 * are present.
 */
export interface ExpressionEvent {
  /** Fully-qualified CDEvent type string, e.g. `dev.cdevents.build.started.0.5.1`. */
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
   * Iron Monkey extension — not part of the CDrus expression schema.
   */
  timeout_ms?: number;
  /**
   * Minimum number of milliseconds the emitter waits after the previous event
   * before emitting this one. Used as the lower bound for timing allocation.
   * Iron Monkey extension — not part of the CDrus expression schema.
   */
  min_wait_ms?: number;
  /**
   * Default CDEvents subject shape contributed by the bundle.
   * Iron Monkey extension — not part of the CDrus expression schema.
   */
  subject?: {
    /** Default subject ID; overridden by workflow or manifest allocation when absent. */
    id?: string;
    /** Default subject content fields merged with workflow and override-level content. */
    content?: Record<string, unknown>;
  };
}

/**
 * A CDrus expression bundle: a named, unversioned grouping of CDEvents that
 * represents the expected output of a particular SDLC tool or pipeline stage.
 * Identity is bound to the (group, author, expression) tuple — not a version.
 * Bundles are discovered from YAML files and indexed by the expression registry.
 */
export interface ExpressionBundle {
  /**
   * Group component of the identity tuple (e.g. `'sol-duara'`, `'payment-engineering'`).
   * Scopes authorship within an enterprise or organisation.
   */
  group: string;
  /**
   * Author component of the identity tuple (e.g. `'iron-monkey'`, `'mchen'`).
   * The engineer or tool whose intent this expression encodes.
   */
  author: string;
  /**
   * Expression name component of the identity tuple (e.g. `'build'`, `'deploy'`).
   * Referenced in workflow YAML as `expression`, `author/expression`, or
   * `group/author/expression`.
   */
  expression: string;
  /** Optional human-readable description of what this bundle models. */
  description?: string;
  /** Ordered list of CDEvents this bundle declares the tool will produce. */
  produces: ExpressionEvent[];
}
