/**
 * @module chain/fallback
 * Generates a locally-produced fallback chain ID when the Conduit service is
 * unreachable. The URN encodes the workflow name slug, a compact ISO timestamp,
 * and a random nonce so IDs are unique across retries without a central
 * authority.
 */

import { randomBytes } from 'crypto';

/**
 * Creates a fallback chain ID URN for use when Conduit is unavailable.
 * The format is `urn:sol-duara:fallback:<slug>:<timestamp>:<nonce>`, which is
 * not a UUID but remains correlation-friendly in log analysis.
 *
 * @param workflowName - Workflow name that is slugified and embedded in the URN.
 * @returns A unique URN string suitable for use as a CDEvents `chainId`.
 */
export function generateFallbackChainId(workflowName: string): string {
  const slug = slugify(workflowName);
  const timestamp = compactIso();
  const nonce = randomBytes(3).toString('hex');
  return `urn:sol-duara:fallback:${slug}:${timestamp}:${nonce}`;
}

/** Converts a workflow name to a lowercase, hyphen-separated slug safe for URNs. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Returns the current UTC time as a compact ISO string (no separators, no milliseconds). */
function compactIso(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}
