/**
 * @module emitter/runner
 * Top-level orchestrator for a single Iron Monkey workflow run. Wires together
 * config loading, workflow validation, expression resolution, manifest
 * building, failure injection, and event emission over the configured bus.
 * After all events are emitted it sends a `dev.cdevents.chain.end` sentinel to
 * close the Sympraxis chain.
 */

import { writeFile } from 'fs/promises';
import { validateWorkflow, resolveProduces } from '../workflow/parser.js';
import { loadConfig, resolveBusName } from '../config/loader.js';
import { loadExpressionRegistry } from '../expressions/loader.js';
import { buildManifest } from '../manifest/builder.js';
import { parseInjections } from '../injection/parser.js';
import { applyInjections } from '../injection/apply.js';
import { createBus } from '../bus/interface.js';
import { buildStandaloneEndLink } from '../links/builder.js';
import { createLogger, setLogger } from '../logger/index.js';
import { v4 as uuidv4 } from 'uuid';
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
}

/**
 * Executes a complete Iron Monkey workflow: validates the YAML, builds a
 * pre-allocated event manifest, applies any failure injections, emits all
 * events to the configured message bus in order (respecting concurrency
 * groups), then emits a chain-end sentinel event.
 *
 * @param workflowPath - Filesystem path to the workflow YAML file.
 * @param options - Runtime options controlling bus selection, injection, logging,
 *   and manifest output.
 * @throws {Error} If the workflow is invalid, the bus is misconfigured, any
 *   event fails schema validation, or emission fails.
 */
export async function runWorkflow(workflowPath: string, options: RunOptions): Promise<void> {
  const logger = createLogger({
    level: (options.logLevel ?? 'info') as 'info',
    format: (options.logFormat ?? 'json') as 'json',
  });
  setLogger(logger);

  const config = await loadConfig({
    configPath: options.config,
    cliOverrides: { busName: options.bus },
  });

  const workflow = await validateWorkflow(workflowPath);
  const registry = loadExpressionRegistry();
  const events = resolveProduces(workflow, registry);

  const injections = parseInjections(options.inject ?? []);
  const noConduit = options.conduit === false;
  const busName = resolveBusName(config, options.bus);

  const manifest = await buildManifest(
    { id: workflow.workflow.id, name: workflow.workflow.name },
    events,
    config,
    { noConduit, seed: options.seed, busName },
  );

  const injected = applyInjections(manifest, injections);

  if (options.manifestOut) {
    await writeFile(options.manifestOut, JSON.stringify(injected, null, 2), 'utf-8');
    logger.info({ path: options.manifestOut }, 'manifest written');
  }

  const busConfig = config.buses[busName];
  if (!busConfig) {
    throw new Error(`Bus '${busName}' not found in config.`);
  }

  const bus = await createBus(busName, busConfig);
  await bus.connect();

  try {
    await executeManifest(injected, bus, logger);

    const lastEvent = injected.events[injected.events.length - 1];
    const endLink = buildStandaloneEndLink({
      id: uuidv4(),
      source: lastEvent.source,
      chainId: injected.chainId,
      lastEventId: lastEvent.eventId,
      timestamp: new Date().toISOString(),
    });
    await bus.emit(
      'dev.cdevents.chain.end',
      endLink.id,
      endLink as unknown as typeof lastEvent.payload,
    );
    logger.info({ chainId: injected.chainId }, 'emitted END link');
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

  const delay = event.targetEmitTime - startTime;
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
