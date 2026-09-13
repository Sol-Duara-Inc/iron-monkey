/**
 * @module chain/handshake
 * The chain handshake — ONE `GET /api/v1/chains` before any event is emitted,
 * which is the interface a real tool uses to learn its chain identities.
 *
 * Why a GET, and why here. Chain identifiers are server-minted: an event
 * carrying a `chainId` the authority never issued is refused outright
 * (`unprocessable — unknown chainId <id>: not issued by this authority`), so a
 * run built on locally-minted ids is a run Conduit has no record of. The
 * handshake mints every chain of the run together, before the run's first
 * event exists, and answers them keyed by `chainRef`.
 *
 * It is a GET because repeating it must be safe: the run is keyed
 * `tool + ":" + execution`, so the same pair re-reads the same run and a new
 * execution opens a new one. That is also why the execution handle is supplied
 * rather than omitted — without it a tool holds exactly one run of a workflow
 * for its whole life, and its next pipeline silently joins its previous one.
 *
 * The call ARMS the not-started timer on every chain's first expected event,
 * so it belongs where the pipeline actually begins — inside manifest building
 * for this run — never at process start. A daemon that has been told a run is
 * beginning is already waiting for what the workflow promised.
 *
 * Failure taxonomy is the register client's, unchanged: no daemon answering is
 * legitimate offline (`null`); a daemon answering unusably is a run-scoped
 * failure, because silent fallback while an authority is answering produces a
 * run whose every event is refused at the door.
 */

import { getLogger } from '../logger/index.js';
import { ConduitAnsweredError } from './register.js';
import { flattenChains } from '../workflow/chain-tree.js';
import type { ResolvedChain } from '../workflow/chain-tree.js';
import type { ConduitConfig } from '../config/types.js';

/** The chain identities of one run, as minted together at activation. */
export interface ChainSet {
  /** The run's id. Identical to `chains.root` — not a coincidence to code around. */
  runId: string;
  /** The workflow id the run is of. */
  workflowId: string;
  /** The execution handle the caller supplied, echoed back. */
  executionId?: string;
  /**
   * Every chain the workflow declares, keyed by `chainRef` — the main line
   * (`root`), every blocking spawned chain, and every detached chain. Detached
   * describes what the spawning chain waits on, never what it is called: a
   * tool emitting onto a detached chain needs its id as much as any other.
   */
  chains: Record<string, string>;
}

/** The main line's key in the answered map. */
export const ROOT_CHAIN_REF = 'root';

/** Attempts including the first; a 503 is a transient store failure, so redeliver. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;

function isChainSet(body: unknown): body is ChainSet {
  if (body === null || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  if (typeof b.runId !== 'string' || typeof b.workflowId !== 'string') return false;
  if (b.chains === null || typeof b.chains !== 'object' || Array.isArray(b.chains)) return false;
  return Object.values(b.chains as Record<string, unknown>).every((v) => typeof v === 'string');
}

/**
 * Asks the authority for this run's chain identities.
 *
 * @param workflowId - The workflow id the run is of — the one identifier a
 *   tool legitimately holds, because a human put that workflow in place.
 * @param conduit - Connection details; `undefined`/no URL → `null` (offline).
 * @param opts - `tool` is the asking identity and is REQUIRED by the daemon;
 *   `execution` is this producer's own handle for this execution.
 * @returns The minted chain set, or `null` when no daemon answers.
 * @throws {ConduitAnsweredError} When a daemon answers with an HTTP error, an
 *   unusable body, or dies mid-redelivery.
 */
export async function acquireChains(
  workflowId: string,
  conduit: ConduitConfig | undefined,
  opts: { tool: string; execution?: string },
): Promise<ChainSet | null> {
  const logger = getLogger();
  if (!conduit?.url) return null;

  const query = new URLSearchParams({ workflow: workflowId, tool: opts.tool });
  if (opts.execution) query.set('execution', opts.execution);
  const url = `${conduit.url}/api/v1/chains?${query.toString()}`;

  const headers: Record<string, string> = {};
  // Accepted and currently ignored by the daemon; it will be required later.
  if (conduit.token) headers['Authorization'] = `Bearer ${conduit.token}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      if (attempt === 1) {
        // No daemon answered — offline fallback is legitimate.
        logger.warn(
          { err: (err as Error).message, workflowId, tool: opts.tool },
          'no Conduit daemon answered the chain handshake; offline fallback permitted',
        );
        return null;
      }
      throw new ConduitAnsweredError(
        `Conduit stopped answering during handshake redelivery for '${workflowId}' ` +
          `(attempt ${attempt}/${MAX_ATTEMPTS}): ${(err as Error).message}`,
      );
    }

    if (response.status === 503) {
      if (attempt < MAX_ATTEMPTS) {
        logger.warn({ workflowId, attempt }, 'handshake got 503; redelivering');
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
        continue;
      }
      throw new ConduitAnsweredError(
        `Conduit answered 503 for the chain handshake of '${workflowId}' ${MAX_ATTEMPTS} times`,
        503,
      );
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      const detail =
        body !== null && typeof body === 'object' && 'error' in (body as Record<string, unknown>)
          ? String((body as Record<string, unknown>).error)
          : text.slice(0, 200);
      // 409 names the run that already holds this activation — address that
      // run rather than retrying into the same conflict.
      const conflict =
        response.status === 409 && isChainSet(body) ? ` (existing runId ${body.runId})` : '';
      throw new ConduitAnsweredError(
        `Conduit refused the chain handshake for '${workflowId}' as ` +
          `tool '${opts.tool}': HTTP ${response.status} ${detail}${conflict}`,
        response.status,
      );
    }

    if (!isChainSet(body)) {
      throw new ConduitAnsweredError(
        `Conduit answered the chain handshake for '${workflowId}' with an unusable body: ` +
          text.slice(0, 200),
        response.status,
      );
    }

    logger.info(
      {
        workflowId,
        tool: opts.tool,
        execution: opts.execution,
        runId: body.runId,
        chains: Object.keys(body.chains).sort(),
      },
      'chain handshake complete — every chain of the run is minted',
    );
    return body;
  }

  /* c8 ignore next */
  return null;
}

/**
 * The producer-side gate that survives the move to the handshake: the
 * authority's derivation of the run must name the SAME chains the producer
 * derived.
 *
 * The answered set carries ids only — no per-chain expected events — so the
 * event-level half of the old register gate cannot be checked here. The set
 * half is still the one that matters most in practice: two documents under one
 * workflow id derive different `chainRef` values, and without this the run
 * would mint local URNs for the chains it could not find and have every event
 * on them refused at the door, run after run, with nothing said.
 *
 * @throws {ConduitAnsweredError} Listing every divergence found.
 */
export function assertChainRefsMatchLocal(chainSet: ChainSet, mainChain: ResolvedChain): void {
  const local = flattenChains(mainChain).map((c) => c.chainRef);
  // The producer calls the main line by its own ref; the authority calls it
  // `root`. That one rename is the protocol, not a divergence.
  const localRefs = new Set([ROOT_CHAIN_REF, ...local.slice(1)]);
  const serverRefs = new Set(Object.keys(chainSet.chains));

  const diffs: string[] = [];
  for (const ref of localRefs) {
    if (!serverRefs.has(ref)) diffs.push(`chain ${ref}: the producer derived it, the daemon did not`);
  }
  for (const ref of serverRefs) {
    if (!localRefs.has(ref)) diffs.push(`chain ${ref}: the daemon derived it, the producer did not`);
  }

  if (diffs.length > 0) {
    throw new ConduitAnsweredError(
      `chain handshake mismatch — two documents under one workflow id ` +
        `('${chainSet.workflowId}'):\n  ` +
        diffs.join('\n  ') +
        `\n  producer derived: ${[...localRefs].sort().join(', ')}` +
        `\n  daemon answered:  ${[...serverRefs].sort().join(', ')}`,
    );
  }
}
