/**
 * @module links/builder
 * Factory functions for CDEvents link entries that wire individual events into
 * a Sympraxis chain. Links are embedded in the `context.links` array of each
 * CDEvent payload and allow downstream consumers to traverse the causal chain
 * of a workflow run.
 */

import type { CDEventPayload, LinkEntry } from '../manifest/types.js';

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
 * Builds the `dev.cdevents.chain.end` sentinel as a fully-structured CDEvent
 * envelope (context + subject), so HTTP consumers like Junction Box that
 * validate every body against the base CDEvent shape will accept it.
 *
 * Semantics:
 * - `context.type` is the reserved sentinel discriminant `dev.cdevents.chain.end`.
 * - `context.links` carries a single `END` link pointing at the last
 *   substantive event in the chain — this is where the closure information
 *   lives, mirroring how `PATH` links thread the rest of the chain.
 * - `subject.id` is the chain ID itself (the chain is the subject of its own
 *   closure event), and `subject.content.lastEventId` repeats the END target
 *   for consumers that ignore `links` and only look at `subject.content`.
 *
 * @param opts - Fields needed to build the sentinel payload.
 * @returns A fully populated chain-end CDEvent payload.
 */
export function buildStandaloneEndLink(opts: {
  id: string;
  source: string;
  chainId: string;
  lastEventId: string;
  timestamp: string;
}): CDEventPayload {
  return {
    context: {
      specversion: '0.5.1',
      id: opts.id,
      source: opts.source,
      type: 'dev.cdevents.chain.end',
      timestamp: opts.timestamp,
      chainId: opts.chainId,
      links: [{ type: 'END', target: opts.lastEventId }],
    },
    subject: {
      id: opts.chainId,
      content: {
        lastEventId: opts.lastEventId,
      },
    },
  };
}
