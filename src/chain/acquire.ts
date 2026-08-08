/**
 * @module chain/acquire
 * Acquires a Sympraxis chain ID for a workflow run. Tries the Conduit service
 * first; when NO daemon answers (not configured, connection refused, timeout)
 * it falls back to a locally-generated fallback URN so offline runs are never
 * blocked.
 *
 * FALLBACK IS NARROW BY DESIGN (integration guide v2 §3): when a daemon
 * ANSWERS — any HTTP status, any body — silent fallback is prohibited and a
 * {@link ConduitAnsweredError} is thrown instead, failing the run visibly.
 * Fallback URNs are not UUID-shaped, so they can never activate a dormant
 * workflow on Conduit's side; minting one while an authority is answering
 * silently exits reconciliation.
 */

import { generateFallbackChainId } from './fallback.js';
import { getLogger } from '../logger/index.js';
import type { ConduitConfig } from '../config/types.js';

/**
 * Thrown when a Conduit daemon ANSWERED the acquisition request but the
 * answer was unusable (HTTP error, non-JSON, or an invalid chainId). This is
 * a run-scoped failure: the caller must surface it — never mint a fallback
 * URN while an authority is answering.
 */
export class ConduitAnsweredError extends Error {
  /** HTTP status of the daemon's answer, when one was received. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ConduitAnsweredError';
    this.status = status;
  }
}

/** Describes how a chain ID was obtained and its value. */
export interface ChainIdResult {
  /** The chain ID UUID (or fallback URN) to stamp on every event in the run. */
  chainId: string;
  /**
   * Indicates whether the ID came from the Conduit service (`'conduit'`) or
   * was generated locally (`'fallback'`). Useful for auditing replay fidelity.
   */
  source: 'conduit' | 'fallback';
}

/**
 * Attempts to obtain a chain ID from the Conduit service for the given
 * workflow. Falls back to {@link generateFallbackChainId} ONLY when no daemon
 * answers: not configured, connection-level failure, or timeout. When a
 * daemon answers unusably, throws {@link ConduitAnsweredError} — a run-scoped
 * failure the caller surfaces instead of silently exiting reconciliation.
 *
 * @param workflowName - Human-readable name of the workflow, used as the slug
 *   in the fallback URN and as the `name` field in the Conduit POST body.
 * @param conduit - Optional Conduit connection details. When omitted the
 *   fallback path is taken immediately.
 * @returns A {@link ChainIdResult} with the resolved chain ID and its source.
 * @throws {ConduitAnsweredError} When a daemon answered with an HTTP error,
 *   a non-JSON body, or an invalid chainId.
 */
export async function acquireChainId(
  workflowName: string,
  conduit?: ConduitConfig,
): Promise<ChainIdResult> {
  const logger = getLogger();

  if (!conduit?.url) {
    return { chainId: generateFallbackChainId(workflowName), source: 'fallback' };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (conduit.token) {
    headers['Authorization'] = `Bearer ${conduit.token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${conduit.url}/chainID`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: workflowName }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    // No daemon answered (refused, unreachable, timed out) — the one case
    // where offline fallback minting remains legitimate (guide v2 §3).
    const fallback = generateFallbackChainId(workflowName);
    logger.warn(
      { err: (err as Error).message, fallbackChainId: fallback },
      'no Conduit daemon answered; using offline fallback URN',
    );
    return { chainId: fallback, source: 'fallback' };
  }

  // A daemon ANSWERED. From here on, silent fallback is prohibited.
  if (!response.ok) {
    const redeliver =
      response.status === 503
        ? '; 503 is a transient store failure — redeliver (retry the run)'
        : '';
    throw new ConduitAnsweredError(
      `Conduit answered HTTP ${response.status} (${response.statusText}) for '${workflowName}' — ` +
        `refusing silent fallback while a daemon is answering${redeliver}`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    throw new ConduitAnsweredError(
      `Conduit answered non-JSON for '${workflowName}' — refusing silent fallback while a ` +
        `daemon is answering`,
      response.status,
    );
  }

  if (!isChainIdResponse(body)) {
    throw new ConduitAnsweredError(
      `Conduit response for '${workflowName}' did not contain a valid chainId UUID — refusing ` +
        `silent fallback while a daemon is answering`,
      response.status,
    );
  }

  logger.info({ chainId: body.chainId, source: 'conduit' }, 'acquired chainId from Conduit');
  return { chainId: body.chainId, source: 'conduit' };
}

/**
 * A sub-chain whose id is being acquired. `chainRef` (the positional binding
 * key) distinguishes the chain; `parentChainRef` / `linkKind` carry the
 * parentage the Sympraxis protocol records.
 */
export interface ChainAcquisitionRequest {
  /** Positional binding key (chain anchor), e.g. `'p1.p1.p0.d'`, `'p1.b0'`. */
  chainRef: string;
  /** `chainRef` of the spawning chain. */
  parentChainRef: string;
  /** Relation kind from the spawning event to this chain's first event. */
  linkKind: string;
}

/**
 * Acquires a chain ID for every sub-chain in a run, keyed by `chainRef`. Each
 * chain gets its own id via the same Conduit→fallback cascade
 * {@link acquireChainId} uses for the main chain: when Conduit is configured and
 * reachable the id is minted by Conduit; otherwise a local fallback URN is used.
 * The name posted to Conduit is `<workflowName>:<chainRef>` so each sub-chain is
 * distinguishable.
 *
 * Forward-compat: the Sympraxis protocol defines a single BATCH register
 * (`POST /api/runs` with the whole run graph → a `chainRef`→`chainId` map; see
 * `junction-box/docs/sympraxis-chain-protocol.md`). Until a Sympraxis instance
 * exposes it, this acquires per-chain via the existing `/chainID` endpoint —
 * functionally equivalent, since each chain still gets its own authority-minted
 * id. Swapping in the batch call later changes only this function.
 *
 * @param workflowName - Workflow name, used as the Conduit name prefix.
 * @param requests - One entry per sub-chain to acquire.
 * @param opts - When `noConduit` is true, skips Conduit entirely (fallback URNs).
 * @param conduit - Optional Conduit connection details.
 * @returns Map of `chainRef` → {@link ChainIdResult}.
 */
export async function acquireChainIds(
  workflowName: string,
  requests: ChainAcquisitionRequest[],
  opts: { noConduit: boolean },
  conduit?: ConduitConfig,
): Promise<Map<string, ChainIdResult>> {
  const map = new Map<string, ChainIdResult>();
  for (const req of requests) {
    const name = `${workflowName}:${req.chainRef}`;
    if (opts.noConduit) {
      map.set(req.chainRef, { chainId: generateFallbackChainId(name), source: 'fallback' });
    } else {
      // acquireChainId already cascades Conduit → fallback (and handles an
      // absent conduit.url by falling back), so per-chain reuse is safe.
      map.set(req.chainRef, await acquireChainId(name, conduit));
    }
  }
  return map;
}

interface ChainIdResponse {
  chainId: string;
  issuedAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Type guard that validates the raw Conduit response contains a well-formed
 * UUID in its `chainId` field.
 */
function isChainIdResponse(body: unknown): body is ChainIdResponse {
  return (
    typeof body === 'object' &&
    body !== null &&
    'chainId' in body &&
    typeof (body as ChainIdResponse).chainId === 'string' &&
    UUID_RE.test((body as ChainIdResponse).chainId)
  );
}
