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
  /**
   * JSON pointers (relative to the event payload root) of fields the
   * synthesizer filled in because they were schema-required but absent from
   * the workflow/expression. Empty when synthesis was disabled or unnecessary.
   */
  synthesized?: string[];
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
  /**
   * Indicates how `chainId` was obtained:
   * - `'conduit'`     — issued by the Conduit chain-ID service
   * - `'bus'`         — issued by the target bus (e.g. Junction Box `POST /api/runs/register` `runId`)
   * - `'fallback'`    — locally-generated fallback URN
   */
  chainIdSource: 'conduit' | 'bus' | 'fallback';
  /** ISO 8601 timestamp of when the manifest was built. */
  createdAt: string;
  /** Ordered list of CDEvents to emit, with timing and chain-link wiring resolved. */
  events: ManifestEvent[];
}
