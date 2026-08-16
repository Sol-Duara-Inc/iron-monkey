/**
 * @module chain/register
 * The Proleptic batch-register client — one `POST /api/runs` per run, in
 * place of the retired per-chain `/chainID` shim loop. The daemon mints the
 * ENTIRE chain set atomically and returns it keyed by `chainRef`, plus the
 * boot-minted `instanceId` the producer pins for the run (guide v2 §3).
 *
 * Failure taxonomy (carried over from the fallback-narrowing decision):
 * - NO daemon answers (unconfigured, connection refused, timeout on first
 *   contact) → `null`; offline fallback minting is legitimate.
 * - Daemon ANSWERS unusably (HTTP error, invalid body) →
 *   {@link ConduitAnsweredError}; silent fallback is prohibited.
 * - 503 = transient store failure = REDELIVER: bounded retries with the SAME
 *   Idempotency-Key (safe — a redelivered register returns byte-equivalent
 *   statuses), then a run-scoped error.
 */

import { randomUUID } from 'crypto';
import { getLogger } from '../logger/index.js';
import { flattenChains } from '../workflow/chain-tree.js';
import type { ResolvedChain } from '../workflow/chain-tree.js';
import type { ConduitConfig } from '../config/types.js';

/**
 * Thrown when a Conduit daemon ANSWERED but the answer was unusable. This is
 * a run-scoped failure the caller surfaces — never mint a fallback URN while
 * an authority is answering.
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

/** How a chain ID was obtained and its value (per chain). */
export interface ChainIdResult {
  /** The chain ID UUID (or fallback URN) stamped on the chain's events. */
  chainId: string;
  /** `'conduit'` (batch-registered), `'bus'`, or `'fallback'` (local URN). */
  source: 'conduit' | 'bus' | 'fallback';
}

/** One expected event within a registered chain. */
export interface RegisteredEvent {
  type: string;
  treePath: string;
  order: number;
  timeoutMs: number;
  workflowEventId?: string;
}

/** One chain entry of the register response. */
export interface RegisteredChain {
  chainRef: string;
  chainId: string;
  role: string;
  status: string;
  parentChainId: string | null;
  parentChainRef: string | null;
  parentEventId: string | null;
  linkKind: string | null;
  expectedEvents: RegisteredEvent[];
}

/** The full register response — the run's minted chain set. */
export interface RegisterResult {
  runId: string;
  instanceId: string;
  issuedAt: string;
  chains: RegisteredChain[];
  /**
   * The execution id the daemon's record HOLDS — first registration wins, and
   * a replay cannot rename it. Absent when none was declared or captured.
   */
  executionID?: string;
}

/** Options for {@link registerRun}. */
export interface RegisterOptions {
  /** Reused verbatim across 503 redeliveries; generated when omitted. */
  idempotencyKey?: string;
  /** Total attempts including the first (503 redeliveries). Default 3. */
  maxAttempts?: number;
  /** Optional `tool` scoping — the daemon returns that tool's slice. */
  tool?: string;
  /**
   * The producer's own execution id, declared so Conduit can call back when a
   * TTL expires (im-integration.md addendum 2026-08-15). NOTE THE CASING on
   * the wire: the ruled field name is `executionID`, capital I-D, unlike the
   * neighbouring `workflowId`. Sending it is recommended — without it the
   * daemon can only fall back to capturing `subject.id` from the first
   * `pipelinerun.*` event, and a not-started breach (order-0, nothing ever
   * arrived) is precisely the case where no event could have carried it.
   */
  executionID?: string;
}

const RETRY_DELAY_MS = 250;

function isRegisterResult(body: unknown): body is RegisterResult {
  if (body === null || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.runId === 'string' &&
    typeof b.instanceId === 'string' &&
    Array.isArray(b.chains) &&
    (b.chains as unknown[]).every(
      (c) =>
        c !== null &&
        typeof c === 'object' &&
        typeof (c as RegisteredChain).chainRef === 'string' &&
        typeof (c as RegisteredChain).chainId === 'string' &&
        Array.isArray((c as RegisteredChain).expectedEvents),
    )
  );
}

/**
 * Registers a workflow run: one atomic batch register minting every chain.
 *
 * @param workflowId - The workflow id as known to the daemon's catalog.
 * @param conduit - Conduit connection details; `undefined`/no URL → `null`
 *   (offline).
 * @param opts - Idempotency key, retry budget, optional tool scoping.
 * @returns The minted chain set, or `null` when no daemon answers (the one
 *   case where offline fallback minting remains legitimate).
 * @throws {ConduitAnsweredError} When a daemon answers with an HTTP error
 *   (503 only after the retry budget), an invalid body, or dies mid-redelivery.
 */
export async function registerRun(
  workflowId: string,
  conduit?: ConduitConfig,
  opts: RegisterOptions = {},
): Promise<RegisterResult | null> {
  const logger = getLogger();
  if (!conduit?.url) return null;

  const idempotencyKey = opts.idempotencyKey ?? randomUUID();
  const maxAttempts = opts.maxAttempts ?? 3;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
  };
  if (conduit.token) headers['Authorization'] = `Bearer ${conduit.token}`;

  const body = JSON.stringify({
    workflowId,
    ...(opts.tool ? { tool: opts.tool } : {}),
    // Capital I-D is the ruled spelling; see RegisterOptions.executionID.
    ...(opts.executionID ? { executionID: opts.executionID } : {}),
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${conduit.url}/api/runs`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      if (attempt === 1) {
        // No daemon answered — offline fallback is legitimate (§3).
        logger.warn(
          { err: (err as Error).message, workflowId },
          'no Conduit daemon answered register; offline fallback permitted',
        );
        return null;
      }
      throw new ConduitAnsweredError(
        `Conduit stopped answering during register redelivery of '${workflowId}' ` +
          `(attempt ${attempt}/${maxAttempts}): ${(err as Error).message}`,
      );
    }

    if (response.status === 503) {
      if (attempt < maxAttempts) {
        logger.warn(
          { workflowId, attempt },
          'register got 503 (transient store failure); redelivering with same Idempotency-Key',
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
        continue;
      }
      throw new ConduitAnsweredError(
        `Conduit answered 503 for register '${workflowId}' ${maxAttempts} times — ` +
          `transient store failure persisted; redeliver the run later`,
        503,
      );
    }

    if (!response.ok) {
      throw new ConduitAnsweredError(
        `Conduit answered HTTP ${response.status} (${response.statusText}) registering ` +
          `'${workflowId}' — refusing silent fallback while a daemon is answering`,
        response.status,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new ConduitAnsweredError(
        `Conduit answered non-JSON registering '${workflowId}' — refusing silent fallback ` +
          `while a daemon is answering`,
        response.status,
      );
    }
    if (!isRegisterResult(parsed)) {
      throw new ConduitAnsweredError(
        `Conduit register response for '${workflowId}' is not a valid chain set — refusing ` +
          `silent fallback while a daemon is answering`,
        response.status,
      );
    }

    // F8 (docs/EXECUTION-INQUIRY.md): `executionID` is OPTIONAL on the wire
    // and unusually cased, so a mis-spelled key is a SILENT no-op that only
    // surfaces as a failed inquiry many minutes later. The response echoes the
    // id the record holds, so assert it: a DIFFERENT id is a real
    // disagreement and fails the run; a MISSING echo is warned about, since a
    // daemon predating the field would otherwise be unusable.
    if (opts.executionID !== undefined) {
      if (parsed.executionID === undefined) {
        logger.warn(
          { workflowId, sent: opts.executionID },
          'register did not echo executionID — the expiry inquiry may not be able to reach this run',
        );
      } else if (parsed.executionID !== opts.executionID) {
        throw new ConduitAnsweredError(
          `register for '${workflowId}' holds executionID '${parsed.executionID}' but this run ` +
            `declared '${opts.executionID}' — the daemon's record names a different execution`,
        );
      }
    }

    logger.info(
      {
        workflowId,
        runId: parsed.runId,
        instanceId: parsed.instanceId,
        chains: parsed.chains.length,
        executionID: parsed.executionID,
      },
      'registered run: full chain set minted by Conduit',
    );
    return parsed;
  }

  // Unreachable: every loop path returns or throws.
  throw new ConduitAnsweredError(`register '${workflowId}' exhausted its attempts`);
}

/**
 * The producer-side machine gate: the daemon's derivation of the run must
 * EQUAL the local one — chainRef set and, per chain, (treePath, order, type).
 * Divergent documents under one workflow id are a hard failure BEFORE any
 * event is thrown, mirroring the bench's §4 rule.
 *
 * @throws {ConduitAnsweredError} Listing every divergence found.
 */
export function assertRegisterMatchesLocal(result: RegisterResult, mainChain: ResolvedChain): void {
  const local = new Map(
    flattenChains(mainChain).map((c) => [
      c.chainRef,
      c.events.map((e) => `${e.treePath}|${e.order}|${e.type}`),
    ]),
  );
  const diffs: string[] = [];

  const serverRefs = new Set(result.chains.map((c) => c.chainRef));
  for (const ref of local.keys()) {
    if (!serverRefs.has(ref)) diffs.push(`chain ${ref}: missing from daemon derivation`);
  }
  for (const chain of result.chains) {
    const mine = local.get(chain.chainRef);
    if (!mine) {
      diffs.push(`chain ${chain.chainRef}: daemon derived a chain the producer did not`);
      continue;
    }
    const theirs = [...chain.expectedEvents]
      .sort((a, b) => a.order - b.order)
      .map((e) => `${e.treePath}|${e.order}|${e.type}`);
    if (theirs.join('\n') !== mine.join('\n')) {
      diffs.push(`chain ${chain.chainRef}: expectedEvents diverge (producer vs daemon)`);
    }
  }

  if (diffs.length > 0) {
    throw new ConduitAnsweredError(
      `register derivation mismatch — two documents under one workflow id:\n  ` +
        diffs.join('\n  '),
    );
  }
}
