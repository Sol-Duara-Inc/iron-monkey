/**
 * @module links/builder
 * Factory functions for CDEvents link entries that wire individual events into
 * a directed chain. Links are embedded in the `context.links` array of each
 * CDEvent payload and allow downstream consumers to traverse causal order.
 *
 * Shape follows the CDEvents 0.6.0 links spec:
 * https://github.com/cdevents/spec/blob/main/links.md
 *
 * Three link types are embeddable: `PATH`, `END`, `RELATION`. `START` is
 * intentionally absent — per the spec, `START` is a stand-alone link sent
 * separately, never embedded; chain start is inferred from context.
 */

import type { EndLink, PathLink, RelationLink } from '../manifest/types.js';

/**
 * Creates an embedded `PATH` link pointing back to the immediately preceding
 * event in the chain. The event carrying this link is the implicit `to`.
 *
 * @param previousEventId - `context.id` (UUID) of the preceding event.
 * @returns A spec-shaped `PATH` link.
 */
export function buildPathLink(previousEventId: string): PathLink {
  return { linkType: 'PATH', from: { contextId: previousEventId } };
}

/**
 * Creates an embedded `END` link marking the carrying event as the chain's
 * terminator. Per the CDEvents spec, `end.contextId` references the event
 * id of the chain-ending event — i.e. the very event the link is embedded
 * in (self-reference).
 *
 * @param endingEventId - `context.id` (UUID) of the event carrying this link
 *   (= the event that ends the chain).
 * @returns A spec-shaped `END` link.
 */
export function buildEndLink(endingEventId: string): EndLink {
  return { linkType: 'END', end: { contextId: endingEventId } };
}

/**
 * Creates an embedded `RELATION` link referencing a related event, tagged
 * with a `linkKind` (e.g. `'TRIGGER'`, `'ARTIFACT'`). The carrying event is
 * the implicit `source` per the spec.
 *
 * @param linkKind - Relation discriminator, e.g. `'TRIGGER'`.
 * @param targetEventId - `context.id` of the related event.
 * @returns A spec-shaped `RELATION` link.
 */
export function buildRelationLink(linkKind: string, targetEventId: string): RelationLink {
  return { linkType: 'RELATION', linkKind, target: { contextId: targetEventId } };
}
