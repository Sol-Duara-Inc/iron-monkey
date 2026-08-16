/**
 * @module execution/projection
 * Projects an {@link ExecutionRecord} into the inquiry response Conduit's IM
 * plugin consumes (`docs/EXECUTION-INQUIRY.md` §2).
 *
 * There is no separate execution model: the manifest IS the record. It holds
 * every payload, planned time, and live emission status, so this module only
 * reshapes what already exists.
 *
 * The load-bearing distinction — and the one the addendum does not draw — is
 * between an event that was WITHHELD and one that was NEVER REACHED:
 *
 * - **withheld** — fully built, then deliberately not sent (a `missing`
 *   injection). Real, complete, and safe for the plugin to backfill.
 * - **never reached** — the run aborted before this event's turn. It was
 *   never produced; backfilling it would inject a fiction into the record.
 *
 * Both look like "no event arrived" from Conduit's side. Only the first is
 * backfillable, so they must never share an array.
 */

import { allEvents } from './store.js';
import type { ExecutionRecord } from './store.js';
import type { CDEventPayload, ManifestEvent } from '../manifest/types.js';

/** Lifecycle of the simulated pipeline execution. */
export type ExecutionStatus = 'queued' | 'running' | 'finished' | 'failed';

/** Per-event evidence row (the additive `detail` view). */
export interface ExecutionEventDetail {
  treePath?: string;
  workflowEventId: string;
  /** The concrete wire type. */
  type: string;
  chainId: string;
  /** `emitted` | `withheld` | `pending` | `error`. */
  status: 'emitted' | 'withheld' | 'pending' | 'error';
  /** Planned emit time (ISO), including any `late` injection shift. */
  plannedAt: string;
  /** Actual emit time (ISO), when it was emitted. */
  actualAt?: string;
  /** The resolved TTL for this position, in ms. */
  timeoutMs: number;
  /** Plain-English account of why this event is in the state it is in. */
  reason?: string;
}

/**
 * The inquiry response. The four required fields match addendum §1 exactly;
 * `detail` is additive evidence the plugin may ignore.
 */
export interface ExecutionInquiryResponse {
  executionID: string;
  status: ExecutionStatus;
  emitted: CDEventPayload[];
  withheld: CDEventPayload[];
  detail: {
    workflowId: string;
    /** Conduit's minted run id for this execution, when it registered. */
    runId?: string;
    /** The authority identity pinned at registration, when there was one. */
    instanceId?: string;
    startedAt: string;
    endedAt?: string;
    /** The message that aborted the run, when it aborted. */
    failure?: string;
    events: ExecutionEventDetail[];
  };
}

/** `true` when this event was deliberately suppressed by a `missing` injection. */
function isWithheld(event: ManifestEvent): boolean {
  return event.emitStatus === 'skipped';
}

/** The injection specs applied to an event, for the evidence line. */
function injectionSpecs(event: ManifestEvent): string {
  return event.injections.map((i) => `'${i.spec}'`).join(', ');
}

function reasonFor(event: ManifestEvent, aborted: boolean): string | undefined {
  if (isWithheld(event)) {
    const specs = injectionSpecs(event);
    return `simulated: produced but deliberately not sent${specs ? ` (injection ${specs})` : ''}`;
  }
  if (event.emitStatus === 'error') {
    return `emission failed: ${event.emitError ?? 'unknown error'}`;
  }
  if (event.emitStatus === 'emitted') return undefined;
  // Still pending: distinguish "the run died first" from "not due yet". A
  // `late` injection lands here while its shifted time is still in the
  // future, so the scheduled time is the evidence that explains an otherwise
  // unexplained still-running answer (see F9).
  if (aborted) return 'not reached: the execution aborted before this event';
  const specs = injectionSpecs(event);
  return `scheduled for ${new Date(event.targetEmitTime).toISOString()}${
    specs ? ` (injection ${specs})` : ''
  }`;
}

/**
 * Derives the execution's lifecycle state.
 *
 * `failed` means the simulated pipeline failed — a bus emission error aborts
 * the run (it throws in the runner), which is exactly the shape a real failed
 * pipeline has: earlier events emitted, one errored, the rest never reached.
 * A withheld event is NOT a failure; the execution carries on around it.
 */
export function deriveStatus(record: ExecutionRecord): ExecutionStatus {
  const events = allEvents(record.manifest);
  if (record.failure !== undefined || events.some((e) => e.emitStatus === 'error')) {
    return 'failed';
  }
  if (record.endedAt === undefined) {
    return events.some((e) => e.emitStatus === 'emitted') ? 'running' : 'queued';
  }
  return 'finished';
}

/**
 * Projects a record into the inquiry response.
 *
 * `emitted` and `withheld` are ordered by planned emit time, so the plugin's
 * "answer with the first withheld event" takes the earliest one due — the one
 * whose absence Conduit noticed first.
 */
export function projectExecution(record: ExecutionRecord): ExecutionInquiryResponse {
  const status = deriveStatus(record);
  const aborted = status === 'failed';
  const events = [...allEvents(record.manifest)].sort(
    (a, b) => a.targetEmitTime - b.targetEmitTime,
  );

  return {
    executionID: record.executionID,
    status,
    emitted: events.filter((e) => e.emitStatus === 'emitted').map((e) => e.payload),
    withheld: events.filter(isWithheld).map((e) => e.payload),
    detail: {
      workflowId: record.workflowId,
      runId: record.manifest.chainIdSource === 'conduit' ? record.manifest.chainId : undefined,
      instanceId: record.manifest.instanceId,
      startedAt: new Date(record.startedAt).toISOString(),
      endedAt: record.endedAt === undefined ? undefined : new Date(record.endedAt).toISOString(),
      failure: record.failure,
      events: events.map((e) => ({
        treePath: e.treePath,
        workflowEventId: e.workflowEventId,
        type: e.type,
        chainId: e.chainId,
        status: isWithheld(e)
          ? ('withheld' as const)
          : e.emitStatus === 'emitted'
            ? ('emitted' as const)
            : e.emitStatus === 'error'
              ? ('error' as const)
              : ('pending' as const),
        plannedAt: new Date(e.targetEmitTime).toISOString(),
        actualAt:
          e.actualEmitTime === undefined ? undefined : new Date(e.actualEmitTime).toISOString(),
        timeoutMs: e.timeoutMs,
        reason: reasonFor(e, aborted),
      })),
    },
  };
}
