/**
 * @module workflow/chain-tree
 * Resolves a workflow's `produces` / `detach` grammar into a TREE of Sympraxis
 * chains — the producer-side foundation for emitting detached / parallel
 * streams. Unlike {@link resolveProduces} (which flattens and DROPS `detach`),
 * this builder:
 *
 *  - **nests** expression expansions: an `expression:` ref keeps its index on
 *    its axis, and its bundle's `produces` become children *beneath* that index
 *    (never inline-flattened — flattening renumbers siblings and silently
 *    re-binds unrelated chains);
 *  - **descends into `detach`**: each `detach:` list is lifted into its own
 *    {@link ResolvedChain} ({@link ResolvedChain.spawns}), never merged into the
 *    spawning chain's linear sequence;
 *  - **resolves array entries as parallel branches**: an array element under
 *    `produces` becomes its own chain on the `b` axis (its own chainId), spawned
 *    like a detach. The emitter does NOT join — each chain's events are simply
 *    emitted; the receiver (Sympraxis) blocks until the branches complete;
 *  - computes a positional, axis-prefixed **`treePath`** — the Sympraxis binding
 *    key. Every segment is `<axis><index>`, axis ∈ {`p` = produces, `d` =
 *    detach, `b` = parallel branch}, segments joined by `.` (e.g. `p0`,
 *    `p1.p0.p1`, `p1.p1.p0.d0.p0`, `p1.b0.p2`). Top-level `produces` is the `p` axis.
 *
 * Chain anchoring (mirrors `junction-box/docs/sympraxis-chain-protocol.md`,
 * rule c): the main chain's `chainRef` is the sentinel `root`; a detached chain
 * spawned by the event at path `P` has `chainRef` = `${P}.d` and is always a
 * string-prefix of its member events' `treePath`s.
 *
 * NOTE on the spec's worked example: the protocol doc currently renders the
 * detached `ticket-associate` events as `…d0` / `…d1` (expression flattened).
 * That contradicts the doc's own rule (a) "expansion nests" and Junction Box's
 * actual transformer (which recurses into the expression, adding a level). This
 * builder follows rule (a) + JB's real behaviour — `…d0.p0` / `…d0.p1` — so the
 * doc's worked example should be corrected to match.
 */

import { nounVerbFromType } from '../loaders/expression.loader.js';
import type { ExpressionRegistry } from '../loaders/expression.loader.js';
import type { WorkflowFile } from './types.js';

/** A single expected event within a resolved chain, addressed by `treePath`. */
export interface ResolvedChainEvent {
  /** Axis-prefixed positional path from the workflow root — the binding key. */
  treePath: string;
  /** Zero-based position of this event within its own chain (depth-first). */
  order: number;
  /** Human label (noun-verb slug, de-duplicated within the chain). NOT the key. */
  workflowEventId: string;
  /** Fully-qualified CDEvent type string. */
  type: string;
  /** Tool identifier resolved through the field cascade. */
  tool: string;
  /** CDEvents source URI (empty when unset; manifest builder falls back). */
  source: string;
  /** Pipeline / stage name. */
  pipeline: string;
  /** Upper timing bound (ms). */
  timeout_ms: number;
  /** Lower timing bound (ms). */
  min_wait_ms: number;
  /** Resolved subject identity and merged content. */
  subject: { id: string; content?: Record<string, unknown> };
  /** Whether the event came from a direct `event:` item or an expression expansion. */
  origin: 'event' | 'expression';
  /** Path-style expression reference when `origin` is `'expression'`. */
  expressionRef?: string;
}

/**
 * A resolved Sympraxis chain: the main chain (`role: 'main'`, `chainRef:
 * 'root'`) or a detached side-chain (`role: 'detached'`). Detached chains are
 * carried in {@link ResolvedChain.spawns}, never inlined into the parent's
 * `events`, so the producer can fire them independently (fire-and-forget) and
 * the observer can babysit them as their own declared chains.
 */
export interface ResolvedChain {
  /**
   * `'main'` (workflow spine), `'detached'` (fire-and-forget side-chain), or
   * `'branch'` (parallel branch). All three are emitted identically — each with
   * its own chainId; `detached` vs `branch` differs only in whether the RECEIVER
   * blocks on it. The emitter does not join; it just emits the events.
   */
  role: 'main' | 'detached' | 'branch';
  /** Binding key / anchor: `'root'` for main, `${anchorPath}.d` for detached. */
  chainRef: string;
  /** `chainRef` of the chain whose event spawned this one (detached chains only). */
  parentChainRef?: string;
  /** `treePath` of the spawning event (detached chains only). */
  anchorPath?: string;
  /** Relation kind from the spawning event to this chain's first event. */
  linkKind?: string;
  /** Ordered expected events belonging to THIS chain. */
  events: ResolvedChainEvent[];
  /** Chains spawned by `detach:` on events within this chain. */
  spawns: ResolvedChain[];
}

// ── Structural item shapes (cover both workflow-level and bundle-level items) ─
interface AnyEventItem {
  event: string;
  id?: string;
  tool?: string;
  source?: string;
  pipeline?: string;
  timeout_ms?: number;
  min_wait_ms?: number;
  content?: Record<string, unknown>;
  subject?: { id?: string; content?: Record<string, unknown> };
  produces?: ProduceNode[];
  detach?: ProduceNode[];
}
interface OverrideFields {
  tool?: string;
  source?: string;
  timeout_ms?: number;
  min_wait_ms?: number;
  content?: Record<string, unknown>;
}
interface AnyExprItem {
  expression: string;
  tool?: string;
  source?: string;
  pipeline?: string;
  timeout_ms?: number;
  min_wait_ms?: number;
  content?: Record<string, unknown>;
  overrides?: Record<string, OverrideFields>;
  detach?: ProduceNode[];
}
type AnyProduceItem = AnyEventItem | AnyExprItem;
/**
 * A produces/detach entry: an event/expression item, OR an array of entries —
 * a PARALLEL BRANCH. Each branch becomes its own chain (its own chainId). The
 * emitter only produces each chain's events; the receiver (Sympraxis, which
 * holds the same YAML) is what blocks until the branches complete. No join here.
 */
type ProduceNode = AnyProduceItem | ProduceNode[];

const isEvt = (i: AnyProduceItem): i is AnyEventItem => 'event' in i;

/** Fields inherited from an enclosing expression reference, applied as defaults. */
interface Inherited {
  tool?: string;
  source?: string;
  pipeline?: string;
  timeout_ms?: number;
  min_wait_ms?: number;
  content?: Record<string, unknown>;
  overrides?: Record<string, OverrideFields>;
  fromExpr?: boolean;
  exprRef?: string;
}

interface WalkCtx {
  registry: ExpressionRegistry;
  resolution: { group: string; author: string };
  defaults: {
    tool?: string;
    source?: string;
    pipeline?: string;
    timeout_ms?: number;
    min_wait_ms?: number;
    content?: Record<string, unknown>;
  };
}

/** Recursively deep-merges two plain objects (override wins; arrays replace). */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value !== null &&
      value !== undefined &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/** Joins a path segment, omitting the leading dot at the root. */
function appendSeg(base: string, seg: string): string {
  return base ? `${base}.${seg}` : seg;
}

/** Allocates a chain-unique label by suffixing a counter on collisions. */
function allocateId(base: string, seen: Map<string, number>): string {
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

/**
 * Resolves a validated workflow into its main {@link ResolvedChain}, with every
 * `detach:` lifted into {@link ResolvedChain.spawns} (recursively).
 *
 * @param workflow - A validated {@link WorkflowFile}.
 * @param registry - Expression registry used to expand `expression:` references.
 * @returns The main chain (`chainRef: 'root'`) with its detached sub-chains.
 */
export function resolveChainTree(
  workflow: WorkflowFile,
  registry: ExpressionRegistry,
): ResolvedChain {
  const wf = workflow.workflow;
  const main: ResolvedChain = { role: 'main', chainRef: 'root', events: [], spawns: [] };
  const ctx: WalkCtx = {
    registry,
    resolution: { group: wf.group ?? '', author: wf.author ?? '' },
    defaults: wf.defaults ?? {},
  };
  walk(wf.produces as unknown as ProduceNode[], 'p', '', main, new Map(), ctx, {});
  return main;
}

/**
 * Walks one `produces` (`axis: 'p'`) or `detach` (`axis: 'd'`) item list,
 * appending event leaves to `chain`, recursing into nested `produces` on the
 * same chain, and lifting `detach` lists into freshly-spawned detached chains.
 */
function walk(
  items: ProduceNode[],
  axis: 'p' | 'd',
  basePath: string,
  chain: ResolvedChain,
  idSeen: Map<string, number>,
  ctx: WalkCtx,
  inherited: Inherited,
): void {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    // An array entry is a PARALLEL BRANCH: its own chain on the `b` axis,
    // spawned just like a detach. There is NO join — the emitter only produces
    // each chain's events with its chainId; the receiver blocks until the
    // branches complete.
    if (Array.isArray(item)) {
      chain.spawns.push(buildBranch(item, basePath, i, chain.chainRef, ctx, inherited));
      continue;
    }

    const path = appendSeg(basePath, `${axis}${i}`);

    if (isEvt(item)) {
      const nv = nounVerbFromType(item.event);
      const override =
        inherited.overrides?.[item.event] ?? inherited.overrides?.[item.id ?? nv] ?? {};

      const tool = override.tool ?? item.tool ?? inherited.tool ?? ctx.defaults.tool ?? '';
      const source =
        override.source ?? item.source ?? inherited.source ?? ctx.defaults.source ?? '';
      const pipeline = item.pipeline ?? inherited.pipeline ?? ctx.defaults.pipeline ?? '';
      const timeout_ms =
        override.timeout_ms ??
        item.timeout_ms ??
        inherited.timeout_ms ??
        ctx.defaults.timeout_ms ??
        5000;
      const min_wait_ms =
        override.min_wait_ms ??
        item.min_wait_ms ??
        inherited.min_wait_ms ??
        ctx.defaults.min_wait_ms ??
        100;

      const mergedContent = deepMerge(
        deepMerge(
          deepMerge(ctx.defaults.content ?? {}, inherited.content ?? {}),
          item.subject?.content ?? item.content ?? {},
        ),
        override.content ?? {},
      );

      const workflowEventId = allocateId((item.id ?? nv).replace('.', '-'), idSeen);

      chain.events.push({
        treePath: path,
        order: chain.events.length,
        workflowEventId,
        type: item.event,
        tool,
        source,
        pipeline,
        timeout_ms,
        min_wait_ms,
        subject: {
          id: item.subject?.id ?? workflowEventId,
          content: Object.keys(mergedContent).length > 0 ? mergedContent : undefined,
        },
        origin: inherited.fromExpr ? 'expression' : 'event',
        expressionRef: inherited.exprRef,
      });

      // Nested produces continue the SAME chain (depth-first, p axis).
      if (item.produces?.length) {
        walk(item.produces, 'p', path, chain, idSeen, ctx, inherited);
      }
      // A detach list is a NEW parallel chain — never part of this sequence.
      if (item.detach?.length) {
        chain.spawns.push(buildDetached(item.detach, path, chain.chainRef, ctx, inherited));
      }
    } else {
      // Expression reference — NESTS: its bundle's produces become children
      // beneath this item's path (p axis), with the resolved bundle's identity
      // as the new resolution context (bare refs swap context on recursion).
      const bundle = ctx.registry.resolveWithContext(item.expression, ctx.resolution);
      const childInherited: Inherited = {
        tool: item.tool ?? inherited.tool,
        source: item.source ?? inherited.source,
        pipeline: item.pipeline ?? inherited.pipeline,
        timeout_ms: item.timeout_ms ?? inherited.timeout_ms,
        min_wait_ms: item.min_wait_ms ?? inherited.min_wait_ms,
        content: deepMerge(inherited.content ?? {}, item.content ?? {}),
        overrides: item.overrides ?? inherited.overrides,
        fromExpr: true,
        exprRef: item.expression,
      };
      const childCtx: WalkCtx = {
        ...ctx,
        resolution: { group: bundle.group, author: bundle.author },
      };
      walk(
        bundle.produces as unknown as ProduceNode[],
        'p',
        path,
        chain,
        idSeen,
        childCtx,
        childInherited,
      );
      // Defensive: a detach attached directly to an expression reference.
      if (item.detach?.length) {
        chain.spawns.push(buildDetached(item.detach, path, chain.chainRef, ctx, inherited));
      }
    }
  }
}

/**
 * Builds a parallel-branch chain from an array entry — same spawn mechanism as
 * {@link buildDetached}, on the `b` axis. NO join is recorded: joining is the
 * receiver's job; the emitter only produces the chain (its own chainId).
 *
 * @param branchItems   - The branch's own ordered items (a sequential p-run).
 * @param anchorPath    - treePath of the forking event (whose `produces` holds
 *                        this branch); the RELATION source.
 * @param index         - Position of this branch among its siblings → `b{index}`.
 * @param parentChainRef - `chainRef` of the chain that forked this branch.
 */
function buildBranch(
  branchItems: ProduceNode[],
  anchorPath: string,
  index: number,
  parentChainRef: string,
  ctx: WalkCtx,
  inherited: Inherited,
): ResolvedChain {
  const branchPath = appendSeg(anchorPath, `b${index}`);
  const br: ResolvedChain = {
    role: 'branch',
    chainRef: branchPath,
    parentChainRef,
    anchorPath,
    linkKind: 'TRIGGER',
    events: [],
    spawns: [],
  };
  // The branch's own items are a sequential (p-axis) run based at the branch path.
  walk(branchItems, 'p', branchPath, br, new Map(), ctx, inherited);
  return br;
}

/** Builds a detached chain from a `detach:` list anchored at `anchorPath`. */
function buildDetached(
  detachItems: ProduceNode[],
  anchorPath: string,
  parentChainRef: string,
  ctx: WalkCtx,
  inherited: Inherited,
): ResolvedChain {
  const det: ResolvedChain = {
    role: 'detached',
    chainRef: `${anchorPath}.d`,
    parentChainRef,
    anchorPath,
    linkKind: 'TRIGGER',
    events: [],
    spawns: [],
  };
  // The detach list is its own ordered sequence on the `d` axis, based at the
  // spawning event's path — so its events sit under `${anchorPath}.d{k}` and the
  // chainRef `${anchorPath}.d` is a prefix of every member's treePath.
  walk(detachItems, 'd', anchorPath, det, new Map(), ctx, inherited);
  return det;
}
