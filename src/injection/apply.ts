/**
 * @module injection/apply
 * Applies parsed failure injections to a pre-built event manifest, producing a
 * mutated copy that the emitter uses. Each injection is matched to a manifest
 * event by its `workflowEventId` (or `treePath`) and transforms the event or
 * the event list according to the injection type (missing, malformed,
 * out-of-order, late, duplicate).
 *
 * Injections may target events on the MAIN chain or on any detached /
 * concurrent-branch sub-chain — so an operator can deliberately withhold,
 * malform, delay, reorder, or duplicate an event in a detached chain (the Chaos
 * Monkey move that drives the receiver's babysitter to a breach). The injection
 * target is matched against `workflowEventId` first, then `treePath` (the latter
 * disambiguates when the same `workflowEventId` appears on more than one chain).
 */

import { applyMalformation } from './malformations.js';
import type { Injection } from './parser.js';
import type { Manifest, ManifestEvent, DetachedManifestChain } from '../manifest/types.js';

/** Deep-clones a chain's events so the original manifest is never mutated. */
function cloneEvents(events: ManifestEvent[]): ManifestEvent[] {
  return events.map((e) => ({
    ...e,
    payload: JSON.parse(JSON.stringify(e.payload)) as typeof e.payload,
    injections: [...e.injections],
  }));
}

/**
 * Applies one injection in place to the chain's `events` array (splicing for
 * the structural types). The array reference is mutated, never reassigned, so
 * callers holding the same reference see the result.
 */
function applyOne(events: ManifestEvent[], idx: number, injection: Injection): void {
  switch (injection.type) {
    case 'missing':
      events[idx].emitStatus = 'skipped';
      events[idx].injections.push({
        type: 'missing',
        spec: `missing:${injection.eventId}`,
        applied: true,
      });
      break;

    case 'malformed': {
      const payload = events[idx].payload as unknown as Record<string, unknown>;
      applyMalformation(payload, injection.malformation, injection.fieldPath, injection.value);
      events[idx].injections.push({
        type: 'malformed',
        spec: `malformed:${injection.eventId}:${injection.malformation}`,
        applied: true,
      });
      break;
    }

    case 'out-of-order': {
      const [moved] = events.splice(idx, 1);
      const targetIdx = Math.max(0, Math.min(injection.newPosition, events.length));
      events.splice(targetIdx, 0, moved);
      events[targetIdx].injections.push({
        type: 'out-of-order',
        spec: `out-of-order:${injection.eventId}:${injection.newPosition}`,
        applied: true,
      });
      break;
    }

    case 'late':
      events[idx].targetEmitTime += injection.delayMs;
      events[idx].injections.push({
        type: 'late',
        spec: `late:${injection.eventId}:${injection.delayMs}`,
        applied: true,
      });
      break;

    case 'duplicate': {
      const original = events[idx];
      const dupe: ManifestEvent = {
        ...(JSON.parse(JSON.stringify(original)) as ManifestEvent),
        injections: [{ type: 'duplicate', spec: `duplicate:${injection.eventId}`, applied: true }],
      };
      events.splice(idx + 1, 0, dupe);
      break;
    }
  }
}

/**
 * Returns a new manifest with all specified injections applied. The original
 * manifest is not modified; payloads are deep-cloned before mutation. If the
 * injections list is empty the original manifest is returned unchanged.
 *
 * Each injection is matched across the main chain first, then each detached /
 * branch sub-chain, by `workflowEventId` then `treePath`. The matched chain's
 * own events array is transformed, so structural injections (out-of-order,
 * duplicate) act within the chain that owns the targeted event.
 *
 * @param manifest - The source manifest produced by `buildManifest`.
 * @param injections - Parsed injection descriptors from `parseInjections`.
 * @returns A new {@link Manifest} with injections reflected in the events arrays.
 * @throws {Error} If any injection references a target that does not exist on
 *   any chain.
 */
export function applyInjections(manifest: Manifest, injections: Injection[]): Manifest {
  if (injections.length === 0) return manifest;

  const mainEvents = cloneEvents(manifest.events);
  const subChains: DetachedManifestChain[] = (manifest.detachedChains ?? []).map((c) => ({
    ...c,
    events: cloneEvents(c.events),
  }));

  // Search order: main chain first, then each sub-chain. Same array references
  // are mutated in place by applyOne (including splices).
  const chainArrays: ManifestEvent[][] = [mainEvents, ...subChains.map((c) => c.events)];

  for (const injection of injections) {
    let target: { events: ManifestEvent[]; idx: number } | undefined;
    for (const events of chainArrays) {
      const idx = events.findIndex(
        (e) => e.workflowEventId === injection.eventId || e.treePath === injection.eventId,
      );
      if (idx !== -1) {
        target = { events, idx };
        break;
      }
    }
    if (!target) {
      throw new Error(`Injection references unknown event id: '${injection.eventId}'`);
    }
    applyOne(target.events, target.idx, injection);
  }

  return {
    ...manifest,
    events: mainEvents,
    detachedChains: manifest.detachedChains ? subChains : undefined,
  };
}
