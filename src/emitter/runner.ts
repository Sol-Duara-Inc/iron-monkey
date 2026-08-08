/**
 * @module emitter/runner
 * Top-level orchestrator for a single Iron Monkey workflow run. Wires together
 * config loading, workflow validation, expression resolution, manifest
 * building, failure injection, and event emission over the configured bus.
 *
 * Chain closure is expressed as an embedded `END` link on the LAST manifest
 * event (per the CDEvents links spec), not as a separate `chain.end`
 * sentinel event. The chain ends when its last substantive event arrives.
 */

import { writeFile } from 'fs/promises';
import { resolveChainTree } from '../workflow/chain-tree.js';
import { WorkflowSource, FileWorkflowSource } from '../workflow/source.js';
import { loadConfig, resolveBusName } from '../config/loader.js';
import { loadExpressionRegistry } from '../expressions/loader.js';
import { buildManifest } from '../manifest/builder.js';
import { parseInjections } from '../injection/parser.js';
import { applyInjections } from '../injection/apply.js';
import { createBus } from '../bus/interface.js';
import { buildEndLink } from '../links/builder.js';
import { createLogger, setLogger } from '../logger/index.js';
import type { Manifest, ManifestEvent, DetachedManifestChain } from '../manifest/types.js';

/** Options accepted by {@link runWorkflow} from the CLI or programmatic callers. */
export interface RunOptions {
  /** Path to an Iron Monkey config file (YAML or JSON). Auto-discovered when omitted. */
  config?: string;
  /** Named bus to target. Resolved via {@link resolveBusName} when omitted. */
  bus?: string;
  /**
   * When explicitly `false`, skips the Conduit service and generates a local
   * fallback chain ID instead.
   */
  conduit?: boolean;
  /**
   * Optional integer seed for deterministic UUID and timing allocation.
   * Useful for reproducible test runs where the same event IDs and relative
   * timestamps are needed across executions.
   */
  seed?: number;
  /**
   * Failure-injection spec strings, e.g. `['missing:build-started',
   * 'late:test-finished:3000']`. Parsed by {@link parseInjections}.
   */
  inject?: string[];
  /**
   * If set, the pre-emission manifest (with injections applied) is written to
   * this file path as JSON for offline inspection.
   */
  manifestOut?: string;
  /** Pino log level (default: `'info'`). */
  logLevel?: string;
  /** Log format: `'json'` (default) or `'text'` for human-friendly output. */
  logFormat?: string;
  /**
   * When `false`, disables the simulated-data synthesizer. Default `true`.
   */
  synth?: boolean;
  /**
   * When set, overrides every resolved event's `min_wait_ms` and `timeout_ms`
   * to this value, producing fixed-cadence emission (mirrors the spacing of
   * a hand-rolled fire-sequence script).
   */
  interval?: number;
}

/** Result of a single workflow run within a {@link runWorkflows} call. */
export interface WorkflowRunResult {
  /**
   * Name identifying the workflow that was run, derived from
   * {@link WorkflowSource.name}. For {@link FileWorkflowSource} this is the
   * filename (e.g. `'my-pipeline.yaml'`); for other sources it is whatever
   * the source returns from its `name` getter.
   */
  workflowPath: string;
  /** `'fulfilled'` if the run completed without error, `'rejected'` otherwise. */
  status: 'fulfilled' | 'rejected';
  /** Error message when `status` is `'rejected'`. */
  error?: string;
}

/**
 * Fires multiple workflows simultaneously — each as a fully independent run
 * with its own bus connection, chain ID, and timing. One failure does not
 * abort the others. Results are returned in the same order as `sources`.
 *
 * @param sources - Workflow sources to run. Each entry is either a
 *   {@link WorkflowSource} instance or a plain filesystem-path string
 *   (automatically wrapped in {@link FileWorkflowSource}).
 * @param options - Shared runtime options applied to every workflow run.
 * @returns Per-workflow results in input order.
 */
export async function runWorkflows(
  sources: Array<WorkflowSource | string>,
  options: RunOptions,
): Promise<WorkflowRunResult[]> {
  const resolved = sources.map((s) => (typeof s === 'string' ? new FileWorkflowSource(s) : s));
  const settlements = await Promise.allSettled(resolved.map((s) => runWorkflow(s, options)));

  return settlements.map((result, i) => {
    if (result.status === 'fulfilled') {
      return { workflowPath: resolved[i].name, status: 'fulfilled' };
    }
    return {
      workflowPath: resolved[i].name,
      status: 'rejected',
      error: (result.reason as Error)?.message ?? String(result.reason),
    };
  });
}

/**
 * Executes a complete Iron Monkey workflow: retrieves the workflow definition
 * from the source, builds a pre-allocated event manifest, applies any failure
 * injections, decorates the last event with an `END` link, then emits every
 * event to the configured message bus in order (respecting concurrency
 * groups). No separate chain-end sentinel is emitted — the chain ends with
 * its last substantive event.
 *
 * @param source - Workflow source supplying the definition. Accepts a
 *   {@link WorkflowSource} instance or a plain filesystem-path string
 *   (automatically wrapped in {@link FileWorkflowSource}).
 * @param options - Runtime options controlling bus selection, injection,
 *   logging, and manifest output.
 * @throws {Error} If the workflow definition cannot be retrieved, the bus is
 *   misconfigured, any event fails schema validation, or emission fails.
 */
export async function runWorkflow(
  source: WorkflowSource | string,
  options: RunOptions,
): Promise<void> {
  const logger = createLogger({
    level: (options.logLevel ?? 'info') as 'info',
    format: (options.logFormat ?? 'json') as 'json',
  });
  setLogger(logger);

  const config = await loadConfig({
    configPath: options.config,
    cliOverrides: { busName: options.bus },
  });

  const resolvedSource = typeof source === 'string' ? new FileWorkflowSource(source) : source;
  const workflow = await resolvedSource.getWorkflow();
  const registry = loadExpressionRegistry();
  const mainChain = resolveChainTree(workflow, registry);

  // NOTE: the interval override is applied at scheduling time by the manifest
  // builder (via BuildManifestOptions.interval → TimingAllocator), not by
  // rewriting each event's min_wait_ms/timeout_ms here. That keeps the
  // resolved events truthful to the workflow definition and lets the builder
  // distinguish "exact cadence requested" from the jittered default cadence.

  const injections = parseInjections(options.inject ?? []);
  const noConduit = options.conduit === false;
  const busName = resolveBusName(config, options.bus);

  const busConfig = config.buses[busName];
  if (!busConfig) {
    throw new Error(`Bus '${busName}' not found in config.`);
  }

  // Connect the bus first so adapters that issue their own chainId on
  // connection (e.g. Junction Box `POST /api/runs/register` → runId) can hand it back to
  // the manifest builder via the `acquireChainId` hook. This keeps Conduit /
  // fallback as the path for buses that have no opinion on chain identity.
  const bus = await createBus(busName, busConfig);
  await bus.connect();

  let busChainId: string | undefined;
  if (typeof bus.acquireChainId === 'function') {
    busChainId = await bus.acquireChainId(workflow.workflow.name);
    if (busChainId) {
      logger.info({ bus: busName, chainId: busChainId }, 'using chainId acquired from bus');
    }
  }

  const manifest = await buildManifest(
    { id: workflow.workflow.id, name: workflow.workflow.name },
    mainChain,
    config,
    {
      noConduit,
      seed: options.seed,
      busName,
      synth: options.synth !== false,
      chainId: busChainId,
      chainIdSource: busChainId ? 'bus' : undefined,
      interval: options.interval,
    },
  );

  const injected = applyInjections(manifest, injections);

  // Decorate the last manifest event with an embedded END link before any
  // emission happens. The chain's terminator is the last substantive event
  // itself; no separate sentinel is sent. Per CDEvents spec, `end.contextId`
  // self-references the event id of the chain-ending event.
  //
  // Mutates the payload in place — applyInjections may have already
  // rewritten this event's payload (for malformed/late/etc.), but the END
  // link belongs on whatever envelope ultimately ships.
  const lastEvent = injected.events[injected.events.length - 1];
  if (lastEvent) {
    const ctx = lastEvent.payload.context as { id: string; links?: unknown[] };
    const links = (Array.isArray(ctx.links) ? ctx.links : []).slice();
    links.push(buildEndLink(ctx.id));
    ctx.links = links;
    logger.info(
      { chainId: injected.chainId, endingEventId: ctx.id, endingEventType: lastEvent.type },
      'attached END link to last manifest event',
    );
  }

  if (options.manifestOut) {
    await writeFile(options.manifestOut, JSON.stringify(injected, null, 2), 'utf-8');
    logger.info({ path: options.manifestOut }, 'manifest written');
  }

  try {
    await executeManifest(injected, bus, logger);
  } finally {
    await bus.disconnect();
  }

  if (options.manifestOut) {
    await writeFile(options.manifestOut, JSON.stringify(injected, null, 2), 'utf-8');
  }
}

/**
 * Emits a full run: the main chain in order, plus every spawned sub-chain —
 * with RFC §4.7 blocking semantics enforced STRUCTURALLY (Phase 2):
 *
 * - **Blocking** chains (`role: 'blocking'`, from `spawn:`): after emitting a
 *   spawning event, the emitter launches its blocking chains and AWAITS their
 *   completion — including their own nested blocking descendants — before the
 *   next sibling fires. The timing plan already scheduled the sibling past the
 *   nominal blocking end; the await makes it true under chaos too (a `late`
 *   injection inside a blocking chain genuinely stalls the spawning chain).
 * - **Detached** chains (`detach:`): fire-and-forget. They never gate any
 *   sibling or any chain's completion — not even their own parent sub-chain's
 *   resolution — and are drained only before the run returns, so failures
 *   still surface and the process exits cleanly.
 *
 * Each sub-chain runs on its own rebased timeline anchored at the instant its
 * spawning event was emitted (a chain cannot begin before its trigger).
 * There is no join event and no merged result — the wait is purely a gate on
 * the spawning chain's progress (RFC §4.7).
 */
export async function executeManifest(
  manifest: Manifest,
  bus: Awaited<ReturnType<typeof createBus>>,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  // Index sub-chains by the eventId of their spawning (parent) event.
  const spawnsByParent = new Map<string, DetachedManifestChain[]>();
  for (const sub of manifest.detachedChains ?? []) {
    const list = spawnsByParent.get(sub.parentEventId) ?? [];
    list.push(sub);
    spawnsByParent.set(sub.parentEventId, list);
  }

  /** Detached chains launched anywhere in the run; drained before returning. */
  const detachedDrain: Promise<void>[] = [];

  /** Emits one sub-chain, its planned times shifted by the run's drift. */
  async function emitSubChain(sub: DetachedManifestChain, offset: number): Promise<void> {
    for (const ev of sub.events) {
      await emitEvent(ev, bus, logger, ev.targetEmitTime + offset);
      await gateOnSpawns(ev);
    }
  }

  /**
   * Launches every chain spawned by `event`: detached chains join the
   * run-level drain (they gate NOTHING — not even their parent sub-chain's
   * resolution); blocking chains are AWAITED here, which recursively covers
   * their own blocking descendants (§4.7). Emission failures are recorded on
   * the events themselves, so settlement — not success — is what gates.
   *
   * Rebase: the plan anchors a spawned chain at its spawning event's PLANNED
   * time, so the runtime shift is `actual spawn instant − planned spawn
   * time`. Anchoring on the parent (rather than the sub-chain's first event)
   * preserves `late` injections on ANY sub-chain event — including its first.
   */
  async function gateOnSpawns(event: ManifestEvent): Promise<void> {
    const blocking: Promise<void>[] = [];
    const offset = Date.now() - event.targetEmitTime;
    for (const sub of spawnsByParent.get(event.eventId) ?? []) {
      const task = emitSubChain(sub, offset);
      if (sub.role === 'blocking') blocking.push(task);
      else detachedDrain.push(task);
    }
    if (blocking.length > 0) await Promise.allSettled(blocking);
  }

  // Main chain in strict sequence; after each event, its blocking chains
  // gate the next sibling (§4.7) while detached chains fire and forget.
  for (const event of manifest.events) {
    await emitEvent(event, bus, logger);
    await gateOnSpawns(event);
  }

  // Drain every detached chain before returning, so failures surface and the
  // process exits cleanly — draining is cleanup, never §4.7 gating.
  await Promise.allSettled(detachedDrain);
}

/**
 * Emits a single manifest event to the bus, sleeping until its scheduled time.
 * Updates `emitStatus` and `actualEmitTime` in-place so the manifest reflects
 * final state. Each event carries its own chain's `chainId` (main or sub-chain),
 * which is logged for correlation.
 *
 * @param event - The manifest event to emit (mutated in-place after emission).
 * @param bus - Connected bus instance.
 * @param logger - Logger for structured emission logs.
 * @param emitAt - Absolute epoch-ms to emit at. Defaults to the event's
 *   pre-allocated `targetEmitTime`; sub-chains pass a value rebased to their
 *   spawn instant.
 * @throws {Error} Re-throws any bus emission error after recording it on the event.
 */
async function emitEvent(
  event: ManifestEvent,
  bus: Awaited<ReturnType<typeof createBus>>,
  logger: ReturnType<typeof createLogger>,
  emitAt: number = event.targetEmitTime,
): Promise<void> {
  const chainId = event.chainId;
  if (event.emitStatus === 'skipped') {
    logger.info(
      { chainId, eventId: event.eventId, workflowEventId: event.workflowEventId },
      'skipping injected-missing event',
    );
    return;
  }

  // `emitAt` is an absolute wall-clock instant. Sleep until it, not until
  // "start + offset" — that would re-include time already burned and make
  // inter-event gaps grow linearly.
  const delay = emitAt - Date.now();
  if (delay > 0) {
    await sleep(delay);
  }

  try {
    await bus.emit(event.type, event.eventId, event.payload);
    event.emitStatus = 'emitted';
    event.actualEmitTime = Date.now();
    logger.info(
      { chainId, eventId: event.eventId, type: event.type, workflowEventId: event.workflowEventId },
      'event emitted',
    );
  } catch (err) {
    event.emitStatus = 'error';
    event.emitError = (err as Error).message;
    logger.error(
      { chainId, eventId: event.eventId, type: event.type, err: event.emitError },
      'failed to emit event',
    );
    throw err;
  }
}

/** Resolves after `ms` milliseconds; used to pace event emission. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
