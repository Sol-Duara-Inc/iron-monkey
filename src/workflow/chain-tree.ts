/**
 * @module workflow/chain-tree
 * Resolves a workflow's CDrus 0.1.0 `produces` / `spawn` / `detach` grammar
 * into a TREE of Proleptic-protocol chains — the producer-side foundation for
 * emitting spawned streams. Implements the coordinate contract ratified
 * 2026-08-04 (ground truth: `conduit-go/docs/engine/chain-derivation.md` and
 * the goldens in `conduit-go/pkg/cdrus/testdata/goldens/`, mirrored under
 * `tests/fixtures/cdrus-goldens/`):
 *
 *  - **Axes**: every member path segment is `<axis><index>`, axis ∈ {`p` =
 *    produces (same chain), `s` = spawn (Blocking), `d` = detach (Detached)}.
 *    The retired `b` axis is never emitted; a nested list at a chain position
 *    (inside `produces`) is a hard error — RFC-legal documents attach spawned
 *    chains to an event via `spawn:` or `detach:`.
 *  - **Flat form = ONE chain**: an event at path `P` with a flat `spawn:` /
 *    `detach:` list spawns a single chain anchored `${P}.s` / `${P}.d` (a
 *    string-prefix anchor, deliberately not a well-formed segment); entry *i*
 *    sits at `${P}.s{i}` / `${P}.d{i}`, and an `expression:` entry nests its
 *    bundle beneath its slot (`${P}.d0.p0`, …).
 *  - **Nested form = one chain PER inner list**: anchors `${P}.s{i}` /
 *    `${P}.d{i}` (well-formed segments — sibling chains must be distinct);
 *    inner-list items sit on a `p`-run beneath each anchor (`${P}.s0.p0`, …).
 *    The two forms MUST NOT be mixed within one list (RFC §4.7/§4.8).
 *  - **Roles**: `main` (spine) | `blocking` (spawn — the receiver monitors it
 *    under its parent; breach rolls up) | `detached` (independent). The
 *    emitter produces every chain's events identically; Phase 2 adds the
 *    producer-side blocking wait.
 *  - **Expansion NESTS** (never inline-flattens): an `expression:` ref keeps
 *    its authored index on its axis and its bundle's produces become children
 *    beneath that index; resolution context swaps to the referenced bundle.
 *    References are spec-pure — `produces`/`spawn`/`detach` on a reference is
 *    rejected (RFC §4.3).
 */

import { nounVerbFromType } from '../expressions/loader.js';
import { loadEventCatalog, resolveEventType } from '../schema/catalog.js';
import type { ResolvedEventType } from '../schema/catalog.js';
import { deepMerge } from '../util/deep-merge.js';
import type { ExpressionRegistry } from '../expressions/loader.js';
import type { ExpressionBundle } from '../expressions/types.js';
import type { WorkflowFile } from './types.js';

/** A single expected event within a resolved chain, addressed by `treePath`. */
export interface ResolvedChainEvent {
  /** Axis-prefixed positional path from the workflow root — the binding key. */
  treePath: string;
  /** Zero-based position of this event within its own chain (depth-first). */
  order: number;
  /** Human label (noun-verb slug, de-duplicated within the chain). NOT the key. */
  workflowEventId: string;
  /**
   * The AUTHORED event-type string, any §6.1 form, verbatim. This is the
   * derivation/register currency — the daemon derives from the same authored
   * strings, so parity (goldens, `assertRegisterMatchesLocal`) compares this,
   * never the resolved form.
   */
  type: string;
  /**
   * The concrete wire type after §6.1 version resolution (§6.2 step 5):
   * canonical embedded-version spelling for core types, the authored string
   * verbatim for `dev.cdeventsx.*` pass-through. The manifest builder stamps
   * this on `context.type` and looks the payload schema up by it.
   */
  resolvedType: string;
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
  /**
   * Author-given anchor from the item's `as:` (RFC §4.9), carried through
   * resolution for the resolution root's anchor surface. Pure metadata.
   */
  as?: string;
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
   * `'main'` (workflow spine), `'blocking'` (a spawn chain the receiver
   * monitors under its parent — its breach rolls up, and the spawning chain's
   * completion gates on it), or `'detached'` (independent — no rollup). All
   * three are emitted identically today, each with its own chainId; the
   * producer-side blocking wait lands in Phase 2.
   */
  role: 'main' | 'detached' | 'blocking';
  /**
   * Binding key / anchor: `'root'` for main; `${anchorPath}.s` / `.d` for a
   * flat-form chain; `${anchorPath}.s{i}` / `.d{i}` for nested-form chains.
   */
  chainRef: string;
  /** `chainRef` of the chain whose event spawned this one (spawned chains only). */
  parentChainRef?: string;
  /** `treePath` of the spawning event (spawned chains only). */
  anchorPath?: string;
  /** Relation kind from the spawning event to this chain's first event. */
  linkKind?: string;
  /** Ordered expected events belonging to THIS chain. */
  events: ResolvedChainEvent[];
  /** Chains spawned by `spawn:` / `detach:` on events within this chain. */
  spawns: ResolvedChain[];
}

// ── Structural item shapes (cover both workflow-level and bundle-level items) ─
interface AnyEventItem {
  event: string;
  id?: string;
  as?: string;
  tool?: string;
  source?: string;
  pipeline?: string;
  timeout_ms?: number;
  min_wait_ms?: number;
  content?: Record<string, unknown>;
  subject?: { id?: string; content?: Record<string, unknown> };
  produces?: ProduceNode[];
  spawn?: ProduceNode[];
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
  produces?: unknown;
  spawn?: unknown;
  detach?: unknown;
}
type AnyProduceItem = AnyEventItem | AnyExprItem;
/**
 * A raw grammar node. Arrays are legal ONLY as the inner lists of a nested-form
 * `spawn:` / `detach:` (one spawned chain per inner list); at any chain
 * position (a `produces` list, or a spawned chain's own body) an array is the
 * retired concurrent-branch grammar and is rejected with a migration hint.
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
  return resolveRoot(
    wf.produces as unknown as ProduceNode[],
    { group: wf.group ?? '', author: wf.author ?? '' },
    wf.defaults ?? {},
    registry,
  );
}

/**
 * Resolves a top-level Expression into its chain tree — RFC §6.2's
 * expression-rooted resolution, where the Expression itself is the resolution
 * root (its own `(group, author)` is the context, and its top-level `produces`
 * is the root chain's `p` axis). Coordinates are identical to a workflow
 * rooted at the same produces list, which is what makes golden parity between
 * expression-rooted and workflow-rooted derivations byte-comparable.
 *
 * @param bundle - The Expression to resolve (its identity supplies context).
 * @param registry - Expression registry used to expand references.
 * @returns The main chain (`chainRef: 'root'`) with its spawned sub-chains.
 */
export function resolveExpressionTree(
  bundle: ExpressionBundle,
  registry: ExpressionRegistry,
): ResolvedChain {
  return resolveRoot(
    bundle.produces as unknown as ProduceNode[],
    { group: bundle.group, author: bundle.author },
    {},
    registry,
  );
}

/** Shared root-resolution core for workflow- and expression-rooted trees. */
function resolveRoot(
  produces: ProduceNode[],
  resolution: { group: string; author: string },
  defaults: WalkCtx['defaults'],
  registry: ExpressionRegistry,
): ResolvedChain {
  const main: ResolvedChain = { role: 'main', chainRef: 'root', events: [], spawns: [] };
  const ctx: WalkCtx = { registry, resolution, defaults };
  walk(produces, 'p', '', main, new Map(), ctx, {});
  return main;
}

/**
 * Flattens a resolved tree into a list of every chain it contains — the root
 * first, then spawned chains depth-first in declaration order. The shared
 * walker for golden-parity comparison, the contract suite's machine gate, and
 * any consumer that needs "all chains of a run" without re-writing the
 * recursion.
 */
export function flattenChains(root: ResolvedChain): ResolvedChain[] {
  const out: ResolvedChain[] = [];
  const visit = (chain: ResolvedChain): void => {
    out.push(chain);
    chain.spawns.forEach(visit);
  };
  visit(root);
  return out;
}

/**
 * Walks one chain-position item list — a `produces` list (`axis: 'p'`) or the
 * entries of a flat-form spawned chain (`axis: 's'` / `'d'`) — appending event
 * leaves to `chain`, recursing into nested `produces` on the same chain, and
 * lifting `spawn:` / `detach:` lists into freshly-spawned chains.
 */
function walk(
  items: ProduceNode[],
  axis: 'p' | 's' | 'd',
  basePath: string,
  chain: ResolvedChain,
  idSeen: Map<string, number>,
  ctx: WalkCtx,
  inherited: Inherited,
): void {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    // A nested list at a chain position is the retired concurrent-branch
    // grammar (pre-0.1.0 `b` axis) — schema-illegal in CDrus 0.1.0. Spawning
    // requires a triggering event; fail with a migration hint.
    if (Array.isArray(item)) {
      throw new Error(
        `Nested list at ${basePath || 'top level'} (item ${i}): a chain position holds events ` +
          `and expression references only. The concurrent-branch grammar is retired — attach ` +
          `the list to the spawning event's 'spawn:' (Blocking) or 'detach:' (Detached) instead ` +
          `(RFC §4.7/§4.8).`,
      );
    }

    const path = appendSeg(basePath, `${axis}${i}`);

    if (isEvt(item)) {
      // §6.2 step 5: resolve the event version against the vendored catalog.
      // Unknown core types and unsatisfiable ranges are §6.2 MUST-report
      // failures; the authored string stays on `type` (derivation parity),
      // the resolution lands on `resolvedType` (the wire).
      let resolved: ResolvedEventType;
      try {
        resolved = resolveEventType(item.event, loadEventCatalog());
      } catch (err) {
        throw new Error(`Event at ${path}: ${(err as Error).message}`);
      }
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
        resolvedType: resolved.wireType,
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
        as: item.as,
      });

      // Nested produces continue the SAME chain (depth-first, p axis).
      if (item.produces?.length) {
        walk(item.produces, 'p', path, chain, idSeen, ctx, inherited);
      }
      // spawn/detach lists spawn NEW chains — never part of this sequence.
      if (item.spawn?.length) {
        chain.spawns.push(
          ...buildSpawnedChains(item.spawn, 'blocking', path, chain.chainRef, ctx, inherited),
        );
      }
      if (item.detach?.length) {
        chain.spawns.push(
          ...buildSpawnedChains(item.detach, 'detached', path, chain.chainRef, ctx, inherited),
        );
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
      // Spec-pure references (RFC §4.3): chain-bearing keys belong to the
      // events inside the referenced Expression, never to the call site.
      for (const forbidden of ['produces', 'spawn', 'detach'] as const) {
        if (item[forbidden] !== undefined) {
          throw new Error(
            `Expression reference '${item.expression}' at ${path} must not carry ` +
              `'${forbidden}' — declare it on the events inside the referenced Expression ` +
              `(RFC §4.3).`,
          );
        }
      }
      walk(
        bundle.produces as unknown as ProduceNode[],
        'p',
        path,
        chain,
        idSeen,
        childCtx,
        childInherited,
      );
    }
  }
}

/**
 * Builds the spawned chain(s) declared by one `spawn:` (Blocking) or `detach:`
 * (Detached) list, per the ratified dual-form rule (RFC §4.7/§4.8):
 *
 * - **Flat form** (no element is an array): ONE chain anchored
 *   `${anchorPath}.<axis>` — a string-prefix anchor, deliberately not a
 *   well-formed segment. Entry *i* sits at `${anchorPath}.<axis>{i}`; an
 *   `expression:` entry nests its bundle beneath its slot.
 * - **Nested form** (every element is an array): one chain PER inner list,
 *   anchored `${anchorPath}.<axis>{i}` (well-formed segments — sibling chains
 *   must be distinct). Inner-list items run on a `p`-run beneath the anchor.
 * - Mixing the two forms in one list is an error.
 *
 * The axis letter and role travel together: `s`/`blocking`, `d`/`detached`.
 * Both kinds are emitted identically; they differ only in receiver-side breach
 * rollup (and, once Phase 2 lands, the producer-side wait for `blocking`).
 *
 * @param list          - The raw `spawn:`/`detach:` value.
 * @param role          - `'blocking'` for spawn, `'detached'` for detach.
 * @param anchorPath    - treePath of the spawning event (the RELATION source).
 * @param parentChainRef - `chainRef` of the chain whose event spawns these.
 */
function buildSpawnedChains(
  list: ProduceNode[],
  role: 'blocking' | 'detached',
  anchorPath: string,
  parentChainRef: string,
  ctx: WalkCtx,
  inherited: Inherited,
): ResolvedChain[] {
  const axis = role === 'blocking' ? 's' : 'd';
  const keyword = role === 'blocking' ? 'spawn' : 'detach';
  const arrayCount = list.filter((el) => Array.isArray(el)).length;

  if (arrayCount > 0 && arrayCount < list.length) {
    throw new Error(
      `'${keyword}' at ${anchorPath} mixes flat and nested forms — declare ONE chain as a flat ` +
        `list of chain items, or one chain PER nested list, never both (RFC §4.7/§4.8).`,
    );
  }

  if (arrayCount === 0) {
    // Flat form: one chain; entries on the spawn axis based at the anchor.
    const chain: ResolvedChain = {
      role,
      chainRef: `${anchorPath}.${axis}`,
      parentChainRef,
      anchorPath,
      linkKind: 'TRIGGER',
      events: [],
      spawns: [],
    };
    walk(list, axis, anchorPath, chain, new Map(), ctx, inherited);
    return [chain];
  }

  // Nested form: one chain per inner list; members on a p-run beneath each anchor.
  return (list as ProduceNode[][]).map((inner, i) => {
    const chainRef = appendSeg(anchorPath, `${axis}${i}`);
    const chain: ResolvedChain = {
      role,
      chainRef,
      parentChainRef,
      anchorPath,
      linkKind: 'TRIGGER',
      events: [],
      spawns: [],
    };
    walk(inner, 'p', chainRef, chain, new Map(), ctx, inherited);
    return chain;
  });
}
