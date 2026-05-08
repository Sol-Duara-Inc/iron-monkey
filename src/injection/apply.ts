/**
 * @module injection/apply
 * Applies parsed failure injections to a pre-built event manifest, producing a
 * mutated copy that the emitter uses. Each injection is matched to a manifest
 * event by its `workflowEventId` and transforms the event or the event list
 * according to the injection type (missing, malformed, out-of-order, late,
 * duplicate).
 */

import { applyMalformation } from './malformations.js';
import type { Injection } from './parser.js';
import type { Manifest, ManifestEvent } from '../manifest/types.js';

/**
 * Returns a new manifest with all specified injections applied. The original
 * manifest is not modified; payloads are deep-cloned before mutation. If the
 * injections list is empty the original manifest is returned unchanged.
 *
 * Supported injection types:
 * - **missing** — marks the event as `'skipped'` so the emitter omits it.
 * - **malformed** — mutates the event payload via {@link applyMalformation}.
 * - **out-of-order** — moves the event to a new index in the events array.
 * - **late** — adds a delay offset to `targetEmitTime`.
 * - **duplicate** — inserts a deep-cloned copy of the event immediately after
 *   the original.
 *
 * @param manifest - The source manifest produced by `buildManifest`.
 * @param injections - Parsed injection descriptors from `parseInjections`.
 * @returns A new {@link Manifest} with injections reflected in the events array.
 * @throws {Error} If any injection references a `workflowEventId` that does
 *   not exist in the manifest.
 */
export function applyInjections(manifest: Manifest, injections: Injection[]): Manifest {
  if (injections.length === 0) return manifest;

  let events: ManifestEvent[] = manifest.events.map((e) => ({
    ...e,
    payload: JSON.parse(JSON.stringify(e.payload)) as typeof e.payload,
    injections: [...e.injections],
  }));

  for (const injection of injections) {
    const idx = events.findIndex((e) => e.workflowEventId === injection.eventId);
    if (idx === -1) {
      throw new Error(`Injection references unknown event id: '${injection.eventId}'`);
    }

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
          injections: [
            {
              type: 'duplicate',
              spec: `duplicate:${injection.eventId}`,
              applied: true,
            },
          ],
        };
        events.splice(idx + 1, 0, dupe);
        break;
      }
    }
  }

  return { ...manifest, events };
}
