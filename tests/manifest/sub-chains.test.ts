/**
 * Slice 1: the manifest builder models `detach` and concurrent-branch
 * sub-chains. Each sub-chain gets its own chainId, internal PATH/END links, and
 * a RELATION link from the spawning event in the parent chain to the sub-chain's
 * first event. (The emitter — Slice 3 — is what actually throws them.)
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildManifest } from '../../src/manifest/builder.js';
import { validateWorkflow } from '../../src/workflow/parser.js';
import { resolveChainTree } from '../../src/workflow/chain-tree.js';
import { loadExpressionRegistry } from '../../src/expressions/loader.js';
import type { ResolvedChain, ResolvedChainEvent } from '../../src/workflow/chain-tree.js';
import type { IronMonkeyConfig } from '../../src/config/types.js';
import type { LinkEntry } from '../../src/manifest/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(__dirname, '../../schemas/cdevents');
const EXPRESSIONS_DIR = path.resolve(__dirname, '../../expressions');
const WORKFLOWS_DIR = path.resolve(__dirname, '../../examples/workflows');

const BUILD_STARTED = 'dev.cdevents.build.started.0.3.0';
const BUILD_FINISHED = 'dev.cdevents.build.finished.0.3.0';

const config: IronMonkeyConfig = {
  buses: { default: { type: 'rabbitmq', url: 'amqp://localhost' } },
  tools: { jenkins: { source: 'dev/jenkins' } },
  schemasPath: SCHEMAS_DIR,
};
const meta = { id: 'wf', name: 'wf' };

function ev(treePath: string, order: number, type: string, id: string): ResolvedChainEvent {
  return {
    treePath,
    order,
    workflowEventId: id,
    type,
    tool: 'jenkins',
    source: '',
    pipeline: 'p',
    timeout_ms: 100,
    min_wait_ms: 0,
    subject: { id: `subj-${id}` },
    origin: 'event',
  };
}

/** main: build.started (p0, spawns detach) → build.finished (p1). */
function gatedTree(role: 'detached' | 'concurrent'): ResolvedChain {
  const child: ResolvedChain = {
    role,
    chainRef: 'p0.d',
    parentChainRef: 'root',
    anchorPath: 'p0',
    linkKind: 'TRIGGER',
    events: [ev('p0.d0.p0', 0, BUILD_STARTED, 'c0'), ev('p0.d0.p1', 1, BUILD_FINISHED, 'c1')],
    spawns: [],
  };
  return {
    role: 'main',
    chainRef: 'root',
    events: [ev('p0', 0, BUILD_STARTED, 'm0'), ev('p1', 1, BUILD_FINISHED, 'm1')],
    spawns: [child],
  };
}

const linksOf = (e: { payload: { context: { links?: LinkEntry[] } } }): LinkEntry[] =>
  e.payload.context.links ?? [];

describe('buildManifest — detached / branch sub-chains', () => {
  it('lifts a detach into its own chain with a distinct chainId', async () => {
    const m = await buildManifest(meta, gatedTree('detached'), config, { noConduit: true });

    expect(m.events).toHaveLength(2); // main spine only
    expect(m.detachedChains).toHaveLength(1);
    const dc = m.detachedChains![0];
    expect(dc.role).toBe('detached');
    expect(dc.chainRef).toBe('p0.d');
    expect(dc.events.map((e) => e.type)).toEqual([BUILD_STARTED, BUILD_FINISHED]);

    // Own chainId, distinct from the main chain and stamped on its events.
    expect(dc.chainId).not.toBe(m.chainId);
    expect(dc.parentChainId).toBe(m.chainId);
    expect(dc.parentChainRef).toBe('root');
    expect(dc.events.every((e) => e.chainId === dc.chainId)).toBe(true);
    expect(dc.events.every((e) => e.payload.context.chainId === dc.chainId)).toBe(true);
  });

  it('wires a RELATION from the spawning event to the sub-chain first event', async () => {
    const m = await buildManifest(meta, gatedTree('detached'), config, { noConduit: true });
    const dc = m.detachedChains![0];

    const spawning = m.events[0]; // anchorPath p0
    expect(dc.parentEventId).toBe(spawning.eventId);

    const rel = linksOf(spawning).find((l) => l.linkType === 'RELATION');
    expect(rel).toBeDefined();
    expect(rel).toMatchObject({
      linkType: 'RELATION',
      linkKind: 'TRIGGER',
      target: { contextId: dc.events[0].eventId },
    });
  });

  it('gives each sub-chain internal PATH links and an END link on its last event', async () => {
    const m = await buildManifest(meta, gatedTree('detached'), config, { noConduit: true });
    const dc = m.detachedChains![0];

    // First sub-chain event: no PATH (chain start); last: PATH + END.
    expect(linksOf(dc.events[0]).some((l) => l.linkType === 'PATH')).toBe(false);
    expect(linksOf(dc.events[1]).some((l) => l.linkType === 'PATH')).toBe(true);
    const end = linksOf(dc.events[1]).find((l) => l.linkType === 'END');
    expect(end).toMatchObject({ linkType: 'END', end: { contextId: dc.events[1].eventId } });

    // The MAIN chain's END is NOT added by the builder (the runner adds it
    // post-injection), so the last main event has no END here.
    expect(linksOf(m.events[1]).some((l) => l.linkType === 'END')).toBe(false);
  });

  it('stamps treePath on both main and sub-chain events', async () => {
    const m = await buildManifest(meta, gatedTree('detached'), config, { noConduit: true });
    expect(m.events.map((e) => e.treePath)).toEqual(['p0', 'p1']);
    expect(m.detachedChains![0].events.map((e) => e.treePath)).toEqual(['p0.d0.p0', 'p0.d0.p1']);
  });

  it('models a concurrent branch with role "concurrent"', async () => {
    const m = await buildManifest(meta, gatedTree('concurrent'), config, { noConduit: true });
    expect(m.detachedChains![0].role).toBe('concurrent');
  });

  it('disambiguates two content-identical sibling branches by distinct chainIds', async () => {
    const mkBranch = (ref: string): ResolvedChain => ({
      role: 'concurrent',
      chainRef: ref,
      parentChainRef: 'root',
      anchorPath: 'p0',
      linkKind: 'TRIGGER',
      events: [ev(`${ref}0.p0`, 0, BUILD_STARTED, `${ref}-0`)],
      spawns: [],
    });
    const main: ResolvedChain = {
      role: 'main',
      chainRef: 'root',
      events: [ev('p0', 0, BUILD_STARTED, 'm0')],
      spawns: [mkBranch('p0.b0'), mkBranch('p0.b1')],
    };
    const m = await buildManifest(meta, main, config, { noConduit: true });
    expect(m.detachedChains).toHaveLength(2);
    const [a, b] = m.detachedChains!;
    expect(a.chainId).not.toBe(b.chainId); // identical content, distinct ids
    // The spawning event carries one RELATION per branch.
    const rels = linksOf(m.events[0]).filter((l) => l.linkType === 'RELATION');
    expect(rels).toHaveLength(2);
  });

  it('flattens a nested detach with correct parentage', async () => {
    const grandchild: ResolvedChain = {
      role: 'detached',
      chainRef: 'p0.d0.p0.d',
      parentChainRef: 'p0.d',
      anchorPath: 'p0.d0.p0',
      linkKind: 'TRIGGER',
      events: [ev('p0.d0.p0.d0.p0', 0, BUILD_STARTED, 'gc0')],
      spawns: [],
    };
    const child: ResolvedChain = {
      role: 'detached',
      chainRef: 'p0.d',
      parentChainRef: 'root',
      anchorPath: 'p0',
      linkKind: 'TRIGGER',
      events: [ev('p0.d0.p0', 0, BUILD_STARTED, 'c0')],
      spawns: [grandchild],
    };
    const main: ResolvedChain = {
      role: 'main',
      chainRef: 'root',
      events: [ev('p0', 0, BUILD_STARTED, 'm0')],
      spawns: [child],
    };
    const m = await buildManifest(meta, main, config, { noConduit: true });
    expect(m.detachedChains).toHaveLength(2);
    const byRef = new Map(m.detachedChains!.map((c) => [c.chainRef, c]));
    const c = byRef.get('p0.d')!;
    const gc = byRef.get('p0.d0.p0.d')!;
    expect(gc.parentChainId).toBe(c.chainId); // grandchild's parent is the child chain
    expect(gc.parentEventId).toBe(c.events[0].eventId);
  });

  it('acquires each sub-chain its own fallback chainId under --no-conduit', async () => {
    // Slice 2: sub-chain ids come from the Conduit→fallback cascade, the same
    // path the main chain uses — so under --no-conduit they are fallback URNs
    // (source 'fallback'), distinct from the main chain and from event ids.
    const m = await buildManifest(meta, gatedTree('detached'), config, {
      noConduit: true,
      seed: 7,
    });
    const dc = m.detachedChains![0];
    expect(dc.chainIdSource).toBe('fallback');
    expect(dc.chainId).toMatch(/^urn:sol-duara:fallback:/);
    expect(dc.chainId).not.toBe(m.chainId);
    const mainIds = new Set(m.events.map((e) => e.eventId));
    expect(mainIds.has(dc.chainId)).toBe(false);
  });

  it('models the detached chain end-to-end from the real gated workflow', async () => {
    const wf = await validateWorkflow(
      path.join(WORKFLOWS_DIR, 'prod-api-gateway-production-deploy-gated.yaml'),
    );
    const registry = loadExpressionRegistry(EXPRESSIONS_DIR);
    const mainChain = resolveChainTree(wf, registry);

    const m = await buildManifest(
      { id: wf.workflow.id, name: wf.workflow.name },
      mainChain,
      { ...config, tools: {} },
      { noConduit: true },
    );

    // The gated workflow's `deploy` spawns a detached ticket-associate pair.
    expect(m.events.length).toBeGreaterThan(5);
    expect(m.detachedChains).toHaveLength(1);
    const dc = m.detachedChains![0];
    expect(dc.role).toBe('detached');
    expect(dc.events.map((e) => e.type)).toEqual([
      'dev.cdevents.ticket.created.0.2.0',
      'dev.cdevents.ticket.updated.0.2.0',
    ]);
    expect(dc.chainId).not.toBe(m.chainId);

    // RELATION on the spawning event points at the detached chain's first event.
    const spawning = m.events.find((e) => e.eventId === dc.parentEventId);
    expect(spawning).toBeDefined();
    const rel = linksOf(spawning!).find((l) => l.linkType === 'RELATION');
    expect(rel).toMatchObject({ target: { contextId: dc.events[0].eventId } });
  });

  it('produces no detachedChains for a flat (legacy) ResolvedEvent[] input', async () => {
    const m = await buildManifest(
      meta,
      [
        {
          id: 'build-started',
          type: BUILD_STARTED,
          tool: 'jenkins',
          source: '',
          pipeline: 'p',
          timeout_ms: 100,
          min_wait_ms: 0,
          subject: { id: 'b' },
          origin: 'event',
        },
      ],
      config,
      { noConduit: true },
    );
    expect(m.detachedChains).toBeUndefined();
  });
});
