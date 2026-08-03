/**
 * @module expressions/types
 * TypeScript types for CDrus expression bundles. A bundle declares a named
 * SDLC intent — build, deploy, verify, and so on — by listing the CDEvents
 * that together fulfil that intent. Every bundle is bound to an identity tuple:
 * (group, author, expression). Bundles are referenced from workflow `produces`
 * arrays using path-style notation: `expression`, `author/expression`, or
 * `group/author/expression`.
 *
 * Bundle produces items are a discriminated union: either a direct CDEvent
 * entry ({@link BundleEventItem}) or an inlined sub-expression reference
 * ({@link BundleExpressionRef}). Either kind may carry a `detach` sub-chain of
 * observable side events that the main sequence does not wait on.
 */

/**
 * A direct CDEvent entry within an expression bundle's `produces` list.
 */
export interface BundleEventItem {
  /** Fully-qualified CDEvent type string, e.g. `dev.cdevents.build.started.0.3.0`. */
  event: string;
  /**
   * Optional stable identifier for this event within the bundle. Required when
   * multiple events in the same bundle share the same `noun.verb`.
   */
  id?: string;
  /** Upper timing bound in ms. Iron Monkey extension. */
  timeout_ms?: number;
  /** Lower timing bound in ms. Iron Monkey extension. */
  min_wait_ms?: number;
  /** Default CDEvents subject shape contributed by the bundle. Iron Monkey extension. */
  subject?: {
    id?: string;
    content?: Record<string, unknown>;
  };
  /** Default tool identifier for this event. */
  tool?: string;
  /** Default CDEvents source URI for this event. */
  source?: string;
  /** Default pipeline name for this event. */
  pipeline?: string;
  /**
   * Observable side-chain items. Emitted detached from the main sequence — the
   * main chain does not wait on them. Used for async scans, audit trails, and
   * rollback paths that must be observable but must not block the critical path.
   */
  detach?: BundleProducesItem[];
}

/**
 * An inlined sub-expression reference within an expression bundle's `produces`
 * list. When the bundle is loaded the referenced sub-expression is recursively
 * expanded into its constituent CDEvents.
 */
export interface BundleExpressionRef {
  /**
   * Path-style CDrus reference: `'verify'`, `'dsanyika/verify'`, or
   * `'sol-duara/dsanyika/verify'`. Resolved against the registry at parse time
   * using the enclosing bundle's group/author as the disambiguation context.
   */
  expression: string;
  /** Default tool identifier applied to all events in the sub-expression. */
  tool?: string;
  /** Default source URI applied to all events in the sub-expression. */
  source?: string;
  /** Default pipeline name applied to all events in the sub-expression. */
  pipeline?: string;
  /** Default timeout applied to all events in the sub-expression. */
  timeout_ms?: number;
  /** Default min wait applied to all events in the sub-expression. */
  min_wait_ms?: number;
  /** Observable side-chain items attached to this expression reference. */
  detach?: BundleProducesItem[];
}

/** Discriminated union of the two produces item forms within an expression bundle. */
export type BundleProducesItem = BundleEventItem | BundleExpressionRef;

/**
 * A CDrus expression bundle: a named, unversioned grouping of CDEvents that
 * represents the expected output of a particular SDLC tool or pipeline stage.
 * Identity is bound to the (group, author, expression) tuple — not a version.
 */
export interface ExpressionBundle {
  /** Group component of the identity tuple (e.g. `'sol-duara'`). */
  group: string;
  /** Author component of the identity tuple (e.g. `'dsanyika'`). */
  author: string;
  /** Expression name component of the identity tuple (e.g. `'build'`). */
  expression: string;
  /** Optional human-readable description of what this bundle models. */
  description?: string;
  /** Ordered list of CDEvents and/or sub-expression references this bundle declares. */
  produces: BundleProducesItem[];
}

/** @deprecated Use {@link BundleEventItem} instead. */
export type ExpressionEvent = BundleEventItem;
