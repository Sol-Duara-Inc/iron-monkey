/**
 * @module manifest/builder
 * Constructs the pre-allocated event manifest from a resolved workflow. For
 * each event the builder assigns a unique `eventId`, schedules a `targetEmitTime`,
 * builds the CDEvent payload with chain-link wiring, and validates the payload
 * against its CDEvent JSON schema. The resulting manifest is a complete,
 * immutable description of what Iron Monkey will emit — injections are applied
 * separately before emission.
 */

import { v4 as uuidv4 } from 'uuid';
import { IdAllocator } from './id-allocator.js';
import { TimingAllocator } from './timing.js';
import { buildPathLink } from '../links/builder.js';
import { loadSchemas, validateEvent } from '../schema/validator.js';
import { synthesize } from '../synth/synthesizer.js';
import type { ResolvedEvent } from '../workflow/parser.js';
import type { IronMonkeyConfig } from '../config/types.js';
import type { Manifest, ManifestEvent, CDEventPayload } from './types.js';

/** Options controlling manifest construction behaviour. */
export interface BuildManifestOptions {
  /**
   * When `true`, skips the Conduit service and generates a local fallback
   * chain ID. Equivalent to passing `--no-conduit` on the CLI.
   */
  noConduit: boolean;
  /**
   * Optional integer seed for the ID and timing allocators. When set, every
   * run with the same seed and workflow produces identical `eventId` values
   * and relative `targetEmitTime` offsets, enabling deterministic test runs.
   */
  seed?: number;
  /**
   * Pre-acquired chain ID. When supplied the builder bypasses Conduit and
   * fallback generation and uses this value directly.
   */
  chainId?: string;
  /** Source of the pre-acquired `chainId`, stamped on the manifest. */
  chainIdSource?: 'conduit' | 'bus' | 'fallback';
  /**
   * Name of the target bus. Stamped on each manifest event as `targetBus`.
   * Defaults to `IRON_MONKEY_BUS_NAME` env var or `'default'`.
   */
  busName?: string;
  /**
   * When `false`, disables the simulated-data synthesizer so the validator
   * fails loudly on any schema-required field the workflow/expression did not
   * supply. Default `true`.
   */
  synth?: boolean;
  /**
   * Exact per-event emission interval in ms. When set (>= 0), every event is
   * scheduled exactly this far apart with no jitter — the operator asked for a
   * precise cadence (the `--interval` flag / playground interval input). When
   * unset, each event's delay is derived from its `min_wait_ms` / `timeout_ms`
   * budget with ±10% jitter (see {@link TimingAllocator.nextEmitTime}).
   */
  interval?: number;
}

/**
 * Builds a fully pre-allocated event manifest for the given workflow run.
 *
 * Responsibilities:
 * 1. Acquires or generates a Sympraxis chain ID.
 * 2. Loads CDEvent JSON schemas for validation.
 * 3. Allocates deterministic-or-random UUIDs and emission timestamps for every
 *    event.
 * 4. Constructs CDEvent payloads with context (id, source, type, timestamp,
 *    chainId) and subject content, merging tool-source defaults from config.
 * 5. Wires `PATH` links from each event to its predecessor.
 * 6. Schema-validates every payload and throws if any fails.
 *
 * @param workflowMeta - The workflow `id` and `name` used for chain ID
 *   acquisition and manifest metadata.
 * @param events - Flat ordered list of resolved events from
 *   {@link resolveProduces}.
 * @param config - Merged Iron Monkey configuration supplying bus, tool, and
 *   schema-path settings.
 * @param opts - Build-time options controlling conduit bypass, seeding, and
 *   bus targeting.
 * @returns A fully populated {@link Manifest} ready for injection and emission.
 * @throws {Error} If no CDEvent schema is found for an event type or if a
 *   generated payload fails schema validation.
 */
export async function buildManifest(
  workflowMeta: { id: string; name: string },
  events: ResolvedEvent[],
  config: IronMonkeyConfig,
  opts: BuildManifestOptions,
): Promise<Manifest> {
  const { acquireChainId } = await import('../chain/acquire.js');

  let chainId: string;
  let chainIdSource: 'conduit' | 'bus' | 'fallback';

  if (opts.chainId) {
    chainId = opts.chainId;
    chainIdSource = opts.chainIdSource ?? 'fallback';
  } else if (opts.noConduit) {
    const { generateFallbackChainId } = await import('../chain/fallback.js');
    chainId = generateFallbackChainId(workflowMeta.name);
    chainIdSource = 'fallback';
  } else {
    const result = await acquireChainId(workflowMeta.name, config.conduit);
    chainId = result.chainId;
    chainIdSource = result.source;
  }

  const schemas = await loadSchemas(config.schemasPath);
  const targetBus = opts.busName ?? process.env.IRON_MONKEY_BUS_NAME ?? 'default';

  const idAlloc = new IdAllocator(opts.seed);
  const timingAlloc = new TimingAllocator(opts.seed);

  const runId = uuidv4();
  const manifestEvents: ManifestEvent[] = [];

  for (let i = 0; i < events.length; i++) {
    const re = events[i];
    const eventId = idAlloc.nextId();
    // Exact spacing when an interval override is supplied; otherwise the
    // jittered default cadence derived from the event's wait/timeout budget.
    const targetEmitTime =
      typeof opts.interval === 'number' && opts.interval >= 0
        ? timingAlloc.nextExactEmitTime(opts.interval)
        : timingAlloc.nextEmitTime(re.min_wait_ms, re.timeout_ms);
    const timestamp = new Date(targetEmitTime).toISOString();

    // Config tool source overrides blank workflow source; workflow source overrides config when set
    const toolSource = re.source || config.tools[re.tool]?.source || re.tool;

    const links = [];
    if (i > 0) {
      links.push(buildPathLink(manifestEvents[i - 1].eventId));
    }

    const schema = schemas.get(re.type);
    if (!schema) {
      throw new Error(
        `No schema found for event type '${re.type}'. ` +
          `Place the schema at ${config.schemasPath ?? 'schemas/cdevents'}/${re.type}.json or set IRON_MONKEY_SCHEMAS.`,
      );
    }

    let content = re.subject.content ?? {};
    let synthesized: string[] = [];
    if (opts.synth !== false) {
      const result = synthesize(content, schema, {
        toolSource,
        chainId,
        eventType: re.type,
        workflowName: workflowMeta.name,
        subjectId: re.subject.id,
        timestamp,
      });
      content = result.content;
      synthesized = result.synthesized;
    }

    const payload: CDEventPayload = {
      context: {
        specversion: '0.5.1',
        id: eventId,
        source: toolSource,
        type: re.type,
        timestamp,
        chainId,
        links: links.length > 0 ? links : undefined,
      },
      subject: {
        id: re.subject.id,
        content,
      },
    };

    const validationResult = validateEvent(payload, schema);
    if (!validationResult.valid) {
      throw new Error(
        `Event '${re.id}' (type: ${re.type}) failed schema validation:\n${validationResult.errors?.join('\n')}`,
      );
    }

    manifestEvents.push({
      eventId,
      workflowEventId: re.id,
      type: re.type,
      stageId: re.pipeline,
      stageTool: re.tool,
      concurrent: false,
      source: toolSource,
      chainId,
      targetBus,
      targetEmitTime,
      payload,
      injections: [],
      isLast: i === events.length - 1,
      emitStatus: 'pending',
      synthesized,
    });
  }

  return {
    runId,
    workflowId: workflowMeta.id,
    workflowName: workflowMeta.name,
    chainId,
    chainIdSource,
    createdAt: new Date().toISOString(),
    events: manifestEvents,
  };
}
