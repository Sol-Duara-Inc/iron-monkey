/**
 * @module links/builder
 * Factory functions for CDEvents link entries that wire individual events into
 * a Sympraxis chain. Links are embedded in the `context.links` array of each
 * CDEvent payload and allow downstream consumers to traverse the causal chain
 * of a workflow run.
 */

import type { LinkEntry } from '../manifest/types.js';

/**
 * Creates a `PATH` link pointing to the immediately preceding event, indicating
 * direct causal succession within a Sympraxis chain.
 *
 * @param previousEventId - The `eventId` (CDEvents `context.id`) of the
 *   preceding event in the chain.
 * @returns A {@link LinkEntry} of type `'PATH'`.
 */
export function buildPathLink(previousEventId: string): LinkEntry {
  return { type: 'PATH', target: previousEventId };
}

/**
 * Creates an `END` link marking the last event before a chain-end sentinel.
 * Typically embedded in the standalone end-link payload rather than in the
 * final manifest event itself.
 *
 * @param lastEventId - The `eventId` of the final substantive event in the
 *   chain.
 * @returns A {@link LinkEntry} of type `'END'`.
 */
export function buildEndLink(lastEventId: string): LinkEntry {
  return { type: 'END', target: lastEventId };
}

/**
 * Creates a `START` link marking the first event of a Sympraxis chain.
 * Can be embedded in subsequent events to allow consumers to jump directly to
 * the chain origin.
 *
 * @param firstEventId - The `eventId` of the first event in the chain.
 * @returns A {@link LinkEntry} of type `'START'`.
 */
export function buildStartLink(firstEventId: string): LinkEntry {
  return { type: 'START', target: firstEventId };
}

/**
 * The payload shape emitted as the `dev.cdevents.chain.end` sentinel event
 * that closes a Sympraxis chain. Emitted after all manifest events have been
 * published so consumers know the chain is complete.
 */
export interface StandaloneEndLink {
  /** CloudEvents spec version, currently `'0.5.1'`. */
  specversion: string;
  /** Unique UUID for this sentinel event. */
  id: string;
  /** CDEvents source URI identifying the Iron Monkey instance. */
  source: string;
  /** Fixed CDEvent type discriminant for the chain-end sentinel. */
  type: 'dev.cdevents.chain.end';
  /** ISO 8601 timestamp of when the chain end was emitted. */
  timestamp: string;
  /** The chain ID shared by all events in this run. */
  chainId: string;
  /** The `eventId` of the last substantive event before the end sentinel. */
  lastEventId: string;
}

/**
 * Constructs a {@link StandaloneEndLink} payload that signals the completion
 * of a Sympraxis chain. Iron Monkey emits this as the final message on the bus
 * after all manifest events have been published.
 *
 * @param opts - Fields needed to build the sentinel payload.
 * @returns A fully populated {@link StandaloneEndLink}.
 */
export function buildStandaloneEndLink(opts: {
  id: string;
  source: string;
  chainId: string;
  lastEventId: string;
  timestamp: string;
}): StandaloneEndLink {
  return {
    specversion: '0.5.1',
    id: opts.id,
    source: opts.source,
    type: 'dev.cdevents.chain.end',
    timestamp: opts.timestamp,
    chainId: opts.chainId,
    lastEventId: opts.lastEventId,
  };
}
