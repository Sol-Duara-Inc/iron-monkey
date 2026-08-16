/**
 * @module execution/store
 * The execution record store behind the expiry-inquiry endpoint
 * (`GET /api/executions/{executionID}`, see `docs/EXECUTION-INQUIRY.md`).
 *
 * Conduit calls back when a TTL expires, which can be many minutes after the
 * run finished, so records must outlive their run. Two retention rules apply
 * together:
 *
 * - **Capacity is a FLOOR, not a cap.** The store keeps the current run plus
 *   the last nine by default, but a record still inside its inquiry window is
 *   NEVER evicted — even when honoring that pushes the store past capacity.
 *   The alternative loses: a bench doing eleven quick runs would evict run
 *   one while Conduit is still entitled to ask about it, and the daemon would
 *   breach to a human over a bookkeeping artifact rather than a pipeline
 *   truth.
 * - **An open run is never evictable.** Retention is only computed once a run
 *   ends, because the window is measured from the end.
 *
 * The window is the record's own longest event TTL + the five-minute inquiry
 * budget + slack — per record, not a global constant, so a workflow with
 * 20-minute budgets is retained longer than one with 5-second budgets.
 *
 * Evicted ids are remembered (ids only, no bodies) so an aged-out execution
 * answers `410 Gone` rather than `404` — "I had this and let it go" is a
 * different fact from "I never had this", and the daemon acts on it
 * differently.
 */

import type { Manifest, ManifestEvent } from '../manifest/types.js';

/** Conduit's inquiry budget after a TTL expires (addendum §3). */
export const INQUIRY_WINDOW_MS = 5 * 60_000;

/** Slack beyond the computed window, for transmission and clock skew. */
export const RETENTION_SLACK_MS = 60_000;

/** Default number of runs kept once every record is past its window. */
export const DEFAULT_CAPACITY = 10;

/** How many evicted ids are remembered for `410` answers (ids only). */
const EVICTED_MEMORY = 200;

let defaultStore: ExecutionStore | undefined;

/**
 * The process-wide store. The runner records executions into it and the
 * inquiry server answers from it, so they must be the same instance —
 * mirroring how the logger is shared (`getLogger`/`setLogger`).
 */
export function getExecutionStore(): ExecutionStore {
  defaultStore ??= new ExecutionStore();
  return defaultStore;
}

/** Replaces the process-wide store (tests, embedders). */
export function setExecutionStore(store: ExecutionStore): void {
  defaultStore = store;
}

/** One execution's record: the live manifest plus lifecycle bookkeeping. */
export interface ExecutionRecord {
  /** The id Conduit inquires by — IM's own run identity. */
  executionID: string;
  /** The workflow id as known to the daemon's catalog. */
  workflowId: string;
  /**
   * The manifest, held BY REFERENCE. The runner mutates `emitStatus` and
   * `actualEmitTime` in place as it emits, so this is a live view of the
   * execution with no parallel bookkeeping to drift.
   */
  manifest: Manifest;
  /** Epoch ms when the run began. */
  startedAt: number;
  /** Epoch ms when the run ended; absent while it is still running. */
  endedAt?: number;
  /** Set when the run aborted — the message that ended it. */
  failure?: string;
  /**
   * Epoch ms until which this record must remain queryable. Absent while the
   * run is open (an open run is unconditionally retained).
   */
  retainUntil?: number;
}

/** What a lookup found: the record, or why it could not be returned. */
export type ExecutionLookup =
  | { outcome: 'found'; record: ExecutionRecord }
  | { outcome: 'gone' }
  | { outcome: 'unknown' };

/** Options for {@link ExecutionStore}. */
export interface ExecutionStoreOptions {
  /** Floor for retained runs once records are past their windows. */
  capacity?: number;
  /** Clock injection; defaults to `Date.now`. Tests drive it directly. */
  now?: () => number;
}

/**
 * Every event in the run, main chain and spawned chains alike. The inquiry
 * answers for the whole execution, not just the spine.
 */
export function allEvents(manifest: Manifest): ManifestEvent[] {
  return [...manifest.events, ...(manifest.detachedChains ?? []).flatMap((c) => c.events)];
}

/**
 * The longest TTL declared anywhere in the run. Retention is measured against
 * this because the last event to breach is the last one Conduit can ask
 * about.
 */
function longestTtlMs(manifest: Manifest): number {
  return allEvents(manifest).reduce((max, e) => Math.max(max, e.timeoutMs), 0);
}

/**
 * Bounded, retention-aware store of recent executions.
 *
 * Insertion order is preserved; eviction always removes the OLDEST record
 * that is past its retention window, and gives up (retaining above capacity)
 * when every candidate is still inquiry-eligible.
 */
export class ExecutionStore {
  private readonly records = new Map<string, ExecutionRecord>();
  private readonly evicted: string[] = [];
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(opts: ExecutionStoreOptions = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Opens a record for a starting run. The manifest is held by reference, so
   * the runner's in-place status updates are visible to inquiries
   * immediately — a run being asked about WHILE running answers truthfully.
   */
  open(executionID: string, workflowId: string, manifest: Manifest): ExecutionRecord {
    const record: ExecutionRecord = {
      executionID,
      workflowId,
      manifest,
      startedAt: this.now(),
    };
    this.records.set(executionID, record);
    this.evict();
    return record;
  }

  /**
   * Closes a record and arms its retention window: the run's longest TTL plus
   * the inquiry budget plus slack, measured from the end of the run.
   *
   * @param failure - The message that aborted the run, when it aborted.
   */
  close(executionID: string, failure?: string): void {
    const record = this.records.get(executionID);
    if (!record) return;
    const endedAt = this.now();
    record.endedAt = endedAt;
    if (failure !== undefined) record.failure = failure;
    record.retainUntil =
      endedAt + longestTtlMs(record.manifest) + INQUIRY_WINDOW_MS + RETENTION_SLACK_MS;
    this.evict();
  }

  /**
   * Looks one up, distinguishing "aged out" (`gone` → `410`) from "never
   * known" (`unknown` → `404`).
   */
  get(executionID: string): ExecutionLookup {
    const record = this.records.get(executionID);
    if (record) return { outcome: 'found', record };
    if (this.evicted.includes(executionID)) return { outcome: 'gone' };
    return { outcome: 'unknown' };
  }

  /** Every retained record, oldest first. */
  list(): ExecutionRecord[] {
    return [...this.records.values()];
  }

  /** Retained record count — may exceed capacity while windows are open. */
  size(): number {
    return this.records.size;
  }

  /**
   * Drops the oldest records that are past their retention windows, until the
   * store is back at capacity or no evictable candidate remains. Open runs
   * and in-window records are never dropped.
   */
  private evict(): void {
    const now = this.now();
    while (this.records.size > this.capacity) {
      const victim = [...this.records.values()].find(
        (r) => r.retainUntil !== undefined && r.retainUntil <= now,
      );
      if (!victim) return; // everything left is still inquiry-eligible
      this.records.delete(victim.executionID);
      this.evicted.push(victim.executionID);
      if (this.evicted.length > EVICTED_MEMORY) this.evicted.shift();
    }
  }
}
