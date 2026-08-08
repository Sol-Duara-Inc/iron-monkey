/**
 * @module manifest/types
 * Core data types for the Iron Monkey event manifest. The manifest is a
 * pre-allocated, serialisable snapshot of every CDEvent that a workflow run
 * will emit, including timing, chain-link wiring, and (post-injection) failure
 * annotations.
 */

/**
 * A single CDEvents link embedded in `context.links`. Links wire events into
 * a directed CDEvents chain so consumers can reconstruct causal order.
 * Shape follows the CDEvents 0.6.0 links spec
 * (https://github.com/cdevents/spec/blob/main/links.md). `START` links are
 * intentionally not representable here — per the spec, `START` is a
 * stand-alone link sent separately and is never embedded.
 */
export type LinkEntry = PathLink | EndLink | RelationLink;

/**
 * Embedded `PATH` link — points BACK to the immediately preceding event in
 * the chain. The carrying event is the implicit `to`.
 */
export interface PathLink {
  linkType: 'PATH';
  /** The previous event in the chain. */
  from: { contextId: string };
}

/**
 * Embedded `END` link — marks the carrying event as the chain's terminator.
 * Per the spec, `end.contextId` is the event id of the chain-ending event
 * (i.e. the `context.id` of the very event the link is embedded in).
 */
export interface EndLink {
  linkType: 'END';
  end: { contextId: string };
}

/**
 * Embedded `RELATION` link — non-sequential reference to a related event,
 * tagged with `linkKind` (e.g. `TRIGGER`, `ARTIFACT`).
 */
export interface RelationLink {
  linkType: 'RELATION';
  /** Relation discriminator, e.g. `'TRIGGER'`, `'ARTIFACT'`. */
  linkKind: string;
  /** The related event. */
  target: { contextId: string };
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
  /**
   * Positional, axis-prefixed binding key from the chain tree (e.g. `'p0'`,
   * `'p1.p1.p0'`, `'p1.b0.p2'`). Stable across producer/observer; the Sympraxis
   * RELATION/registry binding key. See {@link module:workflow/chain-tree}.
   */
  treePath?: string;
  /** Fully-qualified CDEvent type string, e.g. `dev.cdevents.build.started.0.3.0`. */
  type: string;
  /** Pipeline/stage identifier from the workflow `pipeline` field. */
  stageId: string;
  /** Tool identifier from the workflow `tool` field. */
  stageTool: string;
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
  /**
   * JSON pointers (relative to the event payload root) of fields the
   * synthesizer filled in because they were schema-required but absent from
   * the workflow/expression. Empty when synthesis was disabled or unnecessary.
   */
  synthesized?: string[];
}

/**
 * The `context` block of a CDEvent payload, following the CDEvents 0.6.0-draft
 * specification with Iron Monkey extensions for chain linking.
 */
export interface CDEventContext {
  /** CloudEvents spec version string (e.g. `'0.6.0-draft'`). */
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
 * A pre-allocated detached or blocking spawned sub-chain within a manifest.
 * Each sub-chain is its own Sympraxis chain (its own {@link chainId}), spawned
 * by an event in a parent chain. The spawning event carries a `RELATION` link
 * to this chain's first event; this chain's events carry their own internal
 * `PATH` links and an `END` link on the last event.
 *
 * The role determines how the RECEIVER monitors the chain (it does NOT change
 * how the emitter throws it — both are emitted identically today):
 * - `'detached'` — monitored independently; its breach does NOT roll up to
 *   the parent.
 * - `'blocking'` — a spawn chain, monitored under its parent; its breach ROLLS
 *   UP to the parent, and the spawning chain's completion gates on it. The
 *   receiver-side rollup is the receiver's job; the producer-side wait lands
 *   in Phase 2.
 */
export interface DetachedManifestChain {
  /** How the receiver monitors this chain: `'detached'` (independent) or `'blocking'` (spawn; breach rolls up to parent). */
  role: 'detached' | 'blocking';
  /** Positional binding key (chain anchor) from the chain tree, e.g. `'p1.p1.p0.d'`, `'p1.s0'`. */
  chainRef: string;
  /** This chain's own Sympraxis chain ID, stamped on every one of its events. */
  chainId: string;
  /** How this chain's `chainId` was obtained (Slice 1: always `'fallback'`; acquisition is Slice 2). */
  chainIdSource: 'conduit' | 'bus' | 'fallback';
  /** `chainId` of the chain whose event spawned this one. */
  parentChainId: string;
  /** `chainRef` of the spawning chain. */
  parentChainRef: string;
  /** `eventId` (`context.id`) of the spawning event in the parent chain — the RELATION source. */
  parentEventId: string;
  /** Relation kind from the spawning event to this chain's first event (default `'TRIGGER'`). */
  linkKind: string;
  /** This chain's own ordered events (internal `PATH` links + an `END` link on the last). */
  events: ManifestEvent[];
}

/**
 * The top-level manifest produced by {@link buildManifest}. Captures all run
 * metadata and the ordered, pre-allocated sequence of events to be emitted.
 */
export interface Manifest {
  /** UUID uniquely identifying this manifest (and the Iron Monkey run). */
  runId: string;
  /**
   * The daemon's boot-minted authority identity (`conduitd:user@host:pid:boot`),
   * pinned at batch register (Proleptic §3). Absent for offline/bus-authority
   * runs. A later same-run response carrying a different instanceId means the
   * minting authority restarted — a run-scoped failure, never a silent fallback.
   */
  instanceId?: string;
  /** The workflow `id` field from the YAML. */
  workflowId: string;
  /** The workflow `name` field from the YAML. */
  workflowName: string;
  /** The Sympraxis chain ID shared across all events in this run. */
  chainId: string;
  /**
   * Indicates how `chainId` was obtained:
   * - `'conduit'`     — issued by the Conduit chain-ID service
   * - `'bus'`         — issued by the target bus (e.g. Junction Box `POST /api/runs/register` `runId`)
   * - `'fallback'`    — locally-generated fallback URN
   */
  chainIdSource: 'conduit' | 'bus' | 'fallback';
  /** ISO 8601 timestamp of when the manifest was built. */
  createdAt: string;
  /** Ordered list of CDEvents to emit on the MAIN chain, with timing and chain-link wiring resolved. */
  events: ManifestEvent[];
  /**
   * Detached / blocking sub-chains spawned by events in the main (or a
   * nested) chain, flattened across all nesting levels. Each is its own chain
   * with its own `chainId`; parentage is expressed via `parentChainId`. Absent
   * when the workflow declares no `spawn` / `detach` chains.
   */
  detachedChains?: DetachedManifestChain[];
}
