/**
 * @module manifest/builder
 * Constructs the pre-allocated event manifest from a resolved chain tree. For
 * each event the builder assigns a unique `eventId`, schedules a `targetEmitTime`,
 * builds the CDEvent payload with chain-link wiring, and validates the payload
 * against its CDEvent JSON schema. The resulting manifest is a complete,
 * immutable description of what Iron Monkey will emit — injections are applied
 * separately before emission.
 *
 * The main chain is the workflow spine. `spawn` and `detach`
 * sub-chains (see {@link module:workflow/chain-tree}) are modelled as
 * {@link DetachedManifestChain} entries: each gets its own `chainId`, its own
 * internal `PATH`/`END` links, and a `RELATION` link from the spawning event in
 * the parent chain to this sub-chain's first event. The emitter (Slice 3) is
 * what actually throws them; this builder only describes them.
 */

import { v4 as uuidv4 } from 'uuid';
import { IdAllocator } from './id-allocator.js';
import { planTiming } from './timing.js';
import { buildPathLink, buildEndLink, buildRelationLink } from '../links/builder.js';
import { registerRun, assertRegisterMatchesLocal } from '../chain/register.js';
import { flattenChains } from '../workflow/chain-tree.js';
import { generateFallbackChainId } from '../chain/fallback.js';
import { loadSchemas, validateEvent } from '../schema/validator.js';
import { loadEventCatalog, resolveEventType } from '../schema/catalog.js';
import { synthesize } from '../synth/synthesizer.js';
import type { ResolvedEvent } from '../workflow/parser.js';
import type { ResolvedChain, ResolvedChainEvent } from '../workflow/chain-tree.js';
import type { ChainIdResult } from '../chain/register.js';
import type { IronMonkeyConfig } from '../config/types.js';
import type {
  Manifest,
  ManifestEvent,
  DetachedManifestChain,
  CDEventPayload,
  LinkEntry,
} from './types.js';

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
   * fallback generation and uses this value directly for the MAIN chain.
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

/** Shared, run-scoped construction state passed to the per-chain builders. */
interface BuildContext {
  config: IronMonkeyConfig;
  schemas: Awaited<ReturnType<typeof loadSchemas>>;
  targetBus: string;
  /** Single allocator: the main chain drains it first (ids stay stable), then sub-chains. */
  idAlloc: IdAllocator;
  /** Pre-acquired `chainRef` → chain ID map for every sub-chain (Conduit or fallback). */
  chainIds: Map<string, ChainIdResult>;
  synth: boolean;
  /**
   * Absolute planned emit time per `treePath`, produced by {@link planTiming}
   * BEFORE building — the plan already honors RFC §4.7 blocking waits, so
   * payload timestamps and `targetEmitTime` agree with the wait semantics.
   */
  plannedTimes: Map<string, number>;
  workflowName: string;
}

/** A built chain's events plus the lookups needed to wire RELATION links from it. */
interface BuiltChain {
  events: ManifestEvent[];
  /** treePath → the built event, so a spawning event can be found by its anchor path. */
  byTreePath: Map<string, ManifestEvent>;
  /** `eventId` of this chain's first event (the RELATION target), or undefined when empty. */
  firstEventId: string | undefined;
}

/** Maps a legacy flat {@link ResolvedEvent} list into a main {@link ResolvedChain}. */
function eventsToMainChain(events: ResolvedEvent[]): ResolvedChain {
  return {
    role: 'main',
    chainRef: 'root',
    events: events.map((e, i) => ({
      treePath: `p${i}`,
      order: i,
      workflowEventId: e.id,
      type: e.type,
      resolvedType: resolveEventType(e.type, loadEventCatalog()).wireType,
      tool: e.tool,
      source: e.source,
      pipeline: e.pipeline,
      timeout_ms: e.timeout_ms,
      min_wait_ms: e.min_wait_ms,
      subject: e.subject,
      origin: e.origin,
      expressionRef: e.expressionRef,
    })),
    spawns: [],
  };
}

/**
 * Builds a single manifest event: allocates its id, schedules its emit time,
 * constructs and schema-validates the payload, and wires its `PATH` (predecessor)
 * and — when it ends a sub-chain — `END` links.
 */
function buildEvent(
  re: ResolvedChainEvent,
  chainId: string,
  prevEventId: string | undefined,
  isLastInChain: boolean,
  addEndLink: boolean,
  ctx: BuildContext,
): ManifestEvent {
  const eventId = ctx.idAlloc.nextId();
  const targetEmitTime = ctx.plannedTimes.get(re.treePath);
  if (targetEmitTime === undefined) {
    throw new Error(`internal: no planned emit time for treePath '${re.treePath}'`);
  }
  const timestamp = new Date(targetEmitTime).toISOString();

  // Config tool source overrides blank workflow source; workflow source overrides config when set.
  const toolSource = re.source || ctx.config.tools[re.tool]?.source || re.tool;

  const links: LinkEntry[] = [];
  if (prevEventId) links.push(buildPathLink(prevEventId));
  // `isLast` is positional (always marks the chain's final event); the END link
  // is attached here only for sub-chains — the main chain's END is added by the
  // runner after injections, so `addEndLink` is false for it.
  if (isLastInChain && addEndLink) links.push(buildEndLink(eventId));

  // The WIRE type: the §6.1-resolved concrete version (chain-tree's
  // resolution), which is also the schema-lookup key. `re.type` keeps the
  // authored spelling for derivation/register parity.
  const wireType = re.resolvedType;
  const schema = ctx.schemas.get(wireType);
  if (!schema) {
    const provenance = wireType === re.type ? '' : ` (resolved from '${re.type}')`;
    throw new Error(
      `No schema found for event type '${wireType}'${provenance}. ` +
        `Place the schema at ${ctx.config.schemasPath ?? 'schemas/cdevents'}/ or set IRON_MONKEY_SCHEMAS.`,
    );
  }

  let content = re.subject.content ?? {};
  let synthesized: string[] = [];
  if (ctx.synth !== false) {
    const result = synthesize(content, schema, {
      toolSource,
      chainId,
      eventType: wireType,
      workflowName: ctx.workflowName,
      subjectId: re.subject.id,
      timestamp,
    });
    content = result.content;
    synthesized = result.synthesized;
  }

  const payload: CDEventPayload = {
    context: {
      specversion: '0.6.0-draft',
      id: eventId,
      source: toolSource,
      type: wireType,
      timestamp,
      chainId,
      links: links.length > 0 ? links : undefined,
    },
    subject: { id: re.subject.id, content },
  };

  const validationResult = validateEvent(payload, schema);
  if (!validationResult.valid) {
    throw new Error(
      `Event '${re.workflowEventId}' (type: ${wireType}) failed schema validation:\n${validationResult.errors?.join('\n')}`,
    );
  }

  return {
    eventId,
    workflowEventId: re.workflowEventId,
    treePath: re.treePath,
    type: wireType,
    stageId: re.pipeline,
    stageTool: re.tool,
    source: toolSource,
    chainId,
    targetBus: ctx.targetBus,
    targetEmitTime,
    timeoutMs: re.timeout_ms,
    payload,
    injections: [],
    isLast: isLastInChain,
    emitStatus: 'pending',
    synthesized,
  };
}

/**
 * Builds every event of one chain in order, wiring internal `PATH` links. When
 * `endLast` is true the final event also gets an `END` link (used for
 * sub-chains; the main chain's `END` is attached by the runner post-injection).
 */
function buildChain(
  chain: ResolvedChain,
  chainId: string,
  endLast: boolean,
  ctx: BuildContext,
): BuiltChain {
  const events: ManifestEvent[] = [];
  const byTreePath = new Map<string, ManifestEvent>();
  for (let i = 0; i < chain.events.length; i++) {
    const re = chain.events[i];
    const isLast = i === chain.events.length - 1;
    const prevEventId = i > 0 ? events[i - 1].eventId : undefined;
    const me = buildEvent(re, chainId, prevEventId, isLast, endLast, ctx);
    events.push(me);
    byTreePath.set(re.treePath, me);
  }
  return { events, byTreePath, firstEventId: events[0]?.eventId };
}

/**
 * Recursively builds the detached / branch sub-chains spawned by `parentChain`,
 * appending each as a {@link DetachedManifestChain} to `out` and wiring a
 * `RELATION` link from the spawning event in `parentBuilt` to the sub-chain's
 * first event. Nested spawns recurse with their own parentage.
 */
function buildSpawns(
  parentChain: ResolvedChain,
  parentBuilt: BuiltChain,
  parentChainId: string,
  ctx: BuildContext,
  out: DetachedManifestChain[],
): void {
  for (const spawn of parentChain.spawns) {
    // Each sub-chain's id is acquired up front (Conduit → fallback cascade) and
    // looked up here by chainRef. A missing entry should not happen (all spawns
    // are collected before acquisition) but is handled defensively as fallback.
    const acquired = ctx.chainIds.get(spawn.chainRef);
    const subChainId =
      acquired?.chainId ?? generateFallbackChainId(`${ctx.workflowName}:${spawn.chainRef}`);
    const subChainIdSource = acquired?.source ?? 'fallback';

    const built = buildChain(spawn, subChainId, true, ctx);

    // RELATION: the spawning event (at spawn.anchorPath in the parent chain) →
    // this sub-chain's first event. Append to the parent event's link list.
    const parentEvent = spawn.anchorPath ? parentBuilt.byTreePath.get(spawn.anchorPath) : undefined;
    if (parentEvent && built.firstEventId) {
      const ctxObj = parentEvent.payload.context;
      const existing = Array.isArray(ctxObj.links) ? ctxObj.links : [];
      ctxObj.links = [
        ...existing,
        buildRelationLink(spawn.linkKind ?? 'TRIGGER', built.firstEventId),
      ];
    }

    out.push({
      role: spawn.role === 'blocking' ? 'blocking' : 'detached',
      chainRef: spawn.chainRef,
      chainId: subChainId,
      chainIdSource: subChainIdSource,
      parentChainId,
      parentChainRef: spawn.parentChainRef ?? parentChain.chainRef,
      parentEventId: parentEvent?.eventId ?? '',
      linkKind: spawn.linkKind ?? 'TRIGGER',
      events: built.events,
    });

    // Nested detach/branch within this sub-chain.
    buildSpawns(spawn, built, subChainId, ctx, out);
  }
}

/**
 * Builds a fully pre-allocated event manifest for the given workflow run.
 *
 * Accepts either the resolved main {@link ResolvedChain} (from
 * {@link resolveChainTree}) — in which case `detach` / concurrent-branch
 * sub-chains are modelled — or a flat {@link ResolvedEvent} list (legacy /
 * test callers), treated as a main chain with no sub-chains.
 *
 * @param workflowMeta - The workflow `id` and `name` used for chain ID
 *   acquisition and manifest metadata.
 * @param input - The resolved main chain, or a flat list of resolved events.
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
  input: ResolvedChain | ResolvedEvent[],
  config: IronMonkeyConfig,
  opts: BuildManifestOptions,
): Promise<Manifest> {
  const mainChain = Array.isArray(input) ? eventsToMainChain(input) : input;

  // Every spawned chain's ref, in derivation order (main excluded).
  const spawnRefs = flattenChains(mainChain)
    .slice(1)
    .map((c) => c.chainRef);

  let chainId: string;
  let chainIdSource: 'conduit' | 'bus' | 'fallback';
  let instanceId: string | undefined;
  const chainIds = new Map<string, ChainIdResult>();

  /** Offline minting: one local URN per spawned chain, named as before. */
  const mintOffline = (): void => {
    for (const ref of spawnRefs) {
      chainIds.set(ref, {
        chainId: generateFallbackChainId(`${workflowMeta.name}:${ref}`),
        source: 'fallback',
      });
    }
  };

  if (opts.chainId) {
    // Bus-authority run (e.g. a JB-acquired chainId): the whole run stays
    // under that authority — spawned chains mint local URNs. The per-chain
    // Conduit shim this path once used is retired.
    chainId = opts.chainId;
    chainIdSource = opts.chainIdSource ?? 'fallback';
    mintOffline();
  } else if (opts.noConduit) {
    chainId = generateFallbackChainId(workflowMeta.name);
    chainIdSource = 'fallback';
    mintOffline();
  } else {
    // ONE atomic batch register mints the entire chain set (Proleptic §1);
    // null means no daemon answered — the one legitimate offline case.
    const registered = await registerRun(workflowMeta.id, config.conduit);
    if (!registered) {
      chainId = generateFallbackChainId(workflowMeta.name);
      chainIdSource = 'fallback';
      mintOffline();
    } else {
      // Producer-side machine gate: derivation divergence fails the run
      // BEFORE any event is thrown.
      assertRegisterMatchesLocal(registered, mainChain);
      const main = registered.chains.find((c) => c.role === 'main');
      chainId = main?.chainId ?? registered.runId;
      chainIdSource = 'conduit';
      instanceId = registered.instanceId;
      for (const chain of registered.chains) {
        if (chain.role !== 'main') {
          chainIds.set(chain.chainRef, { chainId: chain.chainId, source: 'conduit' });
        }
      }
    }
  }

  const schemas = await loadSchemas(config.schemasPath);
  const targetBus = opts.busName ?? process.env.IRON_MONKEY_BUS_NAME ?? 'default';

  // Phase 2: the timing PLAN runs first, honoring §4.7 blocking waits — the
  // next sibling after a spawning event is scheduled past the latest Blocking
  // chain end (recursively); detached chains never shift anything.
  const plannedTimes = planTiming(mainChain, { seed: opts.seed, interval: opts.interval });

  const ctx: BuildContext = {
    config,
    schemas,
    targetBus,
    idAlloc: new IdAllocator(opts.seed),
    chainIds,
    synth: opts.synth !== false,
    plannedTimes,
    workflowName: workflowMeta.name,
  };

  const runId = uuidv4();

  // Main chain first: drains the shared id allocator before any sub-chain, so
  // main event ids are identical to the pre-sub-chain behaviour. Its END link
  // is attached by the runner after injections, so endLast is false here.
  const mainBuilt = buildChain(mainChain, chainId, false, ctx);

  const detachedChains: DetachedManifestChain[] = [];
  buildSpawns(mainChain, mainBuilt, chainId, ctx, detachedChains);

  return {
    runId,
    workflowId: workflowMeta.id,
    workflowName: workflowMeta.name,
    chainId,
    chainIdSource,
    instanceId,
    createdAt: new Date().toISOString(),
    events: mainBuilt.events,
    detachedChains: detachedChains.length > 0 ? detachedChains : undefined,
  };
}
