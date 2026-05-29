import { describe, it, expect } from 'vitest';
import { resolveChainTree } from '../../src/workflow/chain-tree.js';
import type { ExpressionRegistry } from '../../src/loaders/expression.loader.js';
import type { ExpressionBundle } from '../../src/expressions/types.js';
import type { WorkflowFile } from '../../src/workflow/types.js';

// ── Event types ──────────────────────────────────────────────────────────────
const PR_STARTED = 'dev.cdevents.pipelinerun.started.0.5.1';
const TICKET_CREATED = 'dev.cdevents.ticket.created.0.5.1';
const TICKET_UPDATED = 'dev.cdevents.ticket.updated.0.5.1';
const TASKRUN_STARTED = 'dev.cdevents.taskrun.started.0.5.1';
const SERVICE_DEPLOYED = 'dev.cdevents.service.deployed.0.5.1';
const TASKRUN_FINISHED = 'dev.cdevents.taskrun.finished.0.5.1';
const PR_FINISHED = 'dev.cdevents.pipelinerun.finished.0.5.1';
const ARTIFACT_SIGNED = 'dev.cdevents.artifact.signed.0.5.1';
const TESTOUTPUT_PUBLISHED = 'dev.cdevents.testoutput.published.0.5.1';
const TS_QUEUED = 'dev.cdevents.testsuiterun.queued.0.5.1';
const TS_STARTED = 'dev.cdevents.testsuiterun.started.0.5.1';
const TS_FINISHED = 'dev.cdevents.testsuiterun.finished.0.5.1';
const TC_QUEUED = 'dev.cdevents.testcaserun.queued.0.5.1';
const TC_STARTED = 'dev.cdevents.testcaserun.started.0.5.1';
const TC_FINISHED = 'dev.cdevents.testcaserun.finished.0.5.1';

const GROUP = 'spin-dev';
const AUTHOR = 'shipwreck-sa';

/** Minimal in-memory registry implementing the resolution rules we rely on. */
function makeRegistry(bundles: ExpressionBundle[]): ExpressionRegistry {
  const byId = new Map(bundles.map((b) => [`${b.group}/${b.author}/${b.expression}`, b]));
  const find = (g: string, a: string, n: string) => byId.get(`${g}/${a}/${n}`);
  return {
    resolve(ref: string): ExpressionBundle {
      const b = bundles.find((x) => x.expression === ref);
      if (!b) throw new Error(`no bundle '${ref}'`);
      return b;
    },
    resolveWithContext(ref, ctx): ExpressionBundle {
      const parts = ref.split('/');
      const tries: [string, string, string][] =
        parts.length === 1
          ? [
              [ctx.group, ctx.author, parts[0]],
              ['example-group', 'user', parts[0]],
            ]
          : parts.length === 2
            ? [[ctx.group, parts[0], parts[1]]]
            : [[parts[0], parts[1], parts[2]]];
      for (const [g, a, n] of tries) {
        const b = find(g, a, n);
        if (b) return b;
      }
      throw new Error(`unresolved expression '${ref}' in ${ctx.group}/${ctx.author}`);
    },
    list: () => bundles.map((b) => ({ name: b.expression, group: b.group, author: b.author })),
  };
}

function bundle(expression: string, produces: ExpressionBundle['produces']): ExpressionBundle {
  return { group: GROUP, author: AUTHOR, expression, produces };
}

function workflow(produces: unknown[]): WorkflowFile {
  return {
    workflow: {
      id: 'wf',
      name: 'wf',
      group: GROUP,
      author: AUTHOR,
      defaults: { timeout_ms: 1_200_000, min_wait_ms: 100 },
      produces,
    },
  } as unknown as WorkflowFile;
}

describe('resolveChainTree — produces/detach grammar → chain tree', () => {
  // The gated `production-deploy` workflow, in miniature: a detached
  // ticket-associate hangs off taskrun.started inside deploy.
  const gatedRegistry = makeRegistry([
    bundle('ticket-associate', [{ event: TICKET_CREATED }, { event: TICKET_UPDATED }]),
    bundle('deploy', [
      { event: TASKRUN_STARTED, detach: [{ expression: 'ticket-associate' }] },
      { event: SERVICE_DEPLOYED },
      { event: TASKRUN_FINISHED },
    ]),
    bundle('production-deploy', [{ expression: 'ticket-associate' }, { expression: 'deploy' }]),
  ]);
  const gatedWorkflow = workflow([
    { event: PR_STARTED },
    { expression: 'production-deploy' },
    { event: PR_FINISHED },
  ]);

  it('builds the main chain as the produces-axis sequence (detach excluded)', () => {
    const main = resolveChainTree(gatedWorkflow, gatedRegistry);

    expect(main.role).toBe('main');
    expect(main.chainRef).toBe('root');
    expect(main.events.map((e) => e.type)).toEqual([
      PR_STARTED,
      TICKET_CREATED, // gate-1 (produces axis)
      TICKET_UPDATED,
      TASKRUN_STARTED,
      SERVICE_DEPLOYED,
      TASKRUN_FINISHED,
      PR_FINISHED,
    ]);
    // Axis-prefixed treePaths; expressions nest (production-deploy=p1, its
    // deploy=p1.p1, taskrun.started=p1.p1.p0, …). This is the canonical set.
    expect(main.events.map((e) => e.treePath)).toEqual([
      'p0',
      'p1.p0.p0',
      'p1.p0.p1',
      'p1.p1.p0',
      'p1.p1.p1',
      'p1.p1.p2',
      'p2',
    ]);
    expect(main.events.map((e) => e.order)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // No main-chain event carries a detach axis segment.
    for (const e of main.events) {
      expect(e.treePath.split('.').some((s) => s.startsWith('d'))).toBe(false);
    }
  });

  it('lifts the detached ticket-associate into its own chain with nested treePaths', () => {
    const main = resolveChainTree(gatedWorkflow, gatedRegistry);

    expect(main.spawns).toHaveLength(1);
    const det = main.spawns[0];
    expect(det.role).toBe('detached');
    expect(det.chainRef).toBe('p1.p1.p0.d'); // anchored at taskrun.started
    expect(det.anchorPath).toBe('p1.p1.p0');
    expect(det.parentChainRef).toBe('root');
    expect(det.linkKind).toBe('TRIGGER');

    expect(det.events.map((e) => e.type)).toEqual([TICKET_CREATED, TICKET_UPDATED]);
    // EXPANSION NESTS: the ticket-associate expression adds a `.d0` level, so
    // its events are `…d0.p0` / `…d0.p1` — NOT the doc worked-example's flat
    // `…d0` / `…d1`. This test is the canonical reference JB must match.
    expect(det.events.map((e) => e.treePath)).toEqual(['p1.p1.p0.d0.p0', 'p1.p1.p0.d0.p1']);
    expect(det.events.map((e) => e.order)).toEqual([0, 1]);

    // The chainRef is a string-prefix of every member event's treePath.
    for (const e of det.events) {
      expect(e.treePath.startsWith(det.chainRef)).toBe(true);
    }
  });

  it('disambiguates content-identical sibling detached chains by treePath', () => {
    // Two events each spawn the SAME detached expression — identical content,
    // distinct structural positions. (Mirrors the async-scan fan-out.)
    const reg = makeRegistry([
      bundle('async-scan', [{ event: ARTIFACT_SIGNED }, { event: TESTOUTPUT_PUBLISHED }]),
    ]);
    const wf = workflow([
      { event: SERVICE_DEPLOYED, detach: [{ expression: 'async-scan' }] },
      { event: TASKRUN_FINISHED, detach: [{ expression: 'async-scan' }] },
    ]);

    const main = resolveChainTree(wf, reg);
    expect(main.spawns).toHaveLength(2);

    const [a, b] = main.spawns;
    const sig = (c: (typeof main.spawns)[number]) => c.events.map((e) => e.type).join('|');
    expect(sig(a)).toBe(sig(b)); // identical content
    expect(a.chainRef).not.toBe(b.chainRef); // distinct binding keys…
    expect(a.chainRef).toBe('p0.d');
    expect(b.chainRef).toBe('p1.d');
    expect(a.events.map((e) => e.treePath)).toEqual(['p0.d0.p0', 'p0.d0.p1']);
    expect(b.events.map((e) => e.treePath)).toEqual(['p1.d0.p0', 'p1.d0.p1']);
  });

  it('resolves array entries as parallel branch chains (own chainId, b axis, no join)', () => {
    // Shipwreck SA `verify`: testsuiterun.started's `produces` is a list of TWO
    // sequential test-case branches. Each branch is its own chain — the emitter
    // gives each its own chainId and emits; the receiver blocks until both
    // complete. There is nothing for the emitter to join.
    const wf = workflow([
      { event: TS_QUEUED },
      {
        event: TS_STARTED,
        produces: [
          [{ event: TC_QUEUED }, { event: TC_STARTED }, { event: TC_FINISHED }],
          [{ event: TC_QUEUED }, { event: TC_STARTED }, { event: TC_FINISHED }],
        ],
      },
      { event: TS_FINISHED },
    ]);

    const main = resolveChainTree(wf, makeRegistry([]));

    // Main chain is the suite spine ONLY — branches are not inlined onto it.
    expect(main.events.map((e) => e.type)).toEqual([TS_QUEUED, TS_STARTED, TS_FINISHED]);
    expect(main.events.map((e) => e.treePath)).toEqual(['p0', 'p1', 'p2']);

    // Two branch chains, each its own chain on the `b` axis, forked at p1.
    expect(main.spawns).toHaveLength(2);
    const [b0, b1] = main.spawns;
    expect([b0.role, b1.role]).toEqual(['branch', 'branch']);
    expect(b0.chainRef).toBe('p1.b0');
    expect(b1.chainRef).toBe('p1.b1');
    expect(b0.anchorPath).toBe('p1'); // forked by testsuiterun.started
    expect(b0.parentChainRef).toBe('root');

    expect(b0.events.map((e) => e.type)).toEqual([TC_QUEUED, TC_STARTED, TC_FINISHED]);
    expect(b0.events.map((e) => e.treePath)).toEqual(['p1.b0.p0', 'p1.b0.p1', 'p1.b0.p2']);
    expect(b1.events.map((e) => e.treePath)).toEqual(['p1.b1.p0', 'p1.b1.p1', 'p1.b1.p2']);

    // Same prefix invariant as detach: chainRef is a prefix of every member.
    for (const e of [...b0.events, ...b1.events]) {
      const ref = e.treePath.startsWith('p1.b0') ? 'p1.b0' : 'p1.b1';
      expect(e.treePath.startsWith(ref)).toBe(true);
    }
  });
});
