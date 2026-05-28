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
import { resolveProduces } from '../workflow/parser.js';
import { WorkflowSource, FileWorkflowSource } from '../workflow/source.js';
import { loadConfig, resolveBusName } from '../loaders/config.loader.js';
import { loadExpressionRegistry } from '../loaders/expression.loader.js';
import { buildManifest } from '../manifest/builder.js';
import { parseInjections } from '../injection/parser.js';
import { applyInjections } from '../injection/apply.js';
import { createBus } from '../bus/interface.js';
import { buildEndLink } from '../links/builder.js';
import { createLogger, setLogger } from '../logger/index.js';
import type { Manifest, ManifestEvent } from '../manifest/types.js';

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
  const events = resolveProduces(workflow, registry);

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
    events,
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
 * Iterates the manifest events grouped by concurrency flag, emitting each
 * group either in parallel (`concurrent: true`) or serially.
 */
async function executeManifest(
  manifest: Manifest,
  bus: Awaited<ReturnType<typeof createBus>>,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const now = Date.now();
  const groups = groupByConcurrency(manifest.events);

  for (const group of groups) {
    if (group.concurrent) {
      await Promise.all(group.events.map((e) => emitEvent(e, bus, logger, now, manifest.chainId)));
    } else {
      for (const event of group.events) {
        await emitEvent(event, bus, logger, now, manifest.chainId);
      }
    }
  }
}

/** A run of consecutive manifest events that share the same `concurrent` flag. */
interface EventGroup {
  /** Whether all events in this group should be emitted simultaneously. */
  concurrent: boolean;
  /** The manifest events that belong to this group. */
  events: ManifestEvent[];
}

/**
 * Splits a flat list of manifest events into consecutive runs that share the
 * same `concurrent` flag value, enabling mixed sequential/parallel emission.
 */
function groupByConcurrency(events: ManifestEvent[]): EventGroup[] {
  const groups: EventGroup[] = [];
  let current: EventGroup | null = null;

  for (const event of events) {
    if (!current || current.concurrent !== event.concurrent) {
      current = { concurrent: event.concurrent, events: [event] };
      groups.push(current);
    } else {
      current.events.push(event);
    }
  }

  return groups;
}

/**
 * Emits a single manifest event to the bus, honouring the pre-allocated
 * `targetEmitTime` by sleeping if necessary. Updates `emitStatus` and
 * `actualEmitTime` in-place so the manifest reflects final state.
 *
 * @param event - The manifest event to emit (mutated in-place after emission).
 * @param bus - Connected bus instance.
 * @param logger - Logger for structured emission logs.
 * @param startTime - Epoch ms captured at the start of the manifest run, used
 *   to compute relative delays.
 * @param chainId - Chain ID shared across all events in this run, logged for
 *   correlation.
 * @throws {Error} Re-throws any bus emission error after recording it on the event.
 */
async function emitEvent(
  event: ManifestEvent,
  bus: Awaited<ReturnType<typeof createBus>>,
  logger: ReturnType<typeof createLogger>,
  startTime: number,
  chainId: string,
): Promise<void> {
  if (event.emitStatus === 'skipped') {
    logger.info(
      { chainId, eventId: event.eventId, workflowEventId: event.workflowEventId },
      'skipping injected-missing event',
    );
    return;
  }

  // `targetEmitTime` is an absolute epoch-ms scheduled by the manifest builder.
  // Sleep until that wall-clock instant, not until "startTime + offset" — using
  // startTime would re-include the time already burned by previous sleeps and
  // make inter-event gaps grow linearly (1s, 2s, 3s, …).
  void startTime;
  const delay = event.targetEmitTime - Date.now();
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
