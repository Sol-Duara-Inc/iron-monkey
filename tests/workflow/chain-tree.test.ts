import { describe, it, expect } from 'vitest';
import { resolveChainTree } from '../../src/workflow/chain-tree.js';
import type { ExpressionRegistry } from '../../src/expressions/loader.js';
import type { ExpressionBundle } from '../../src/expressions/types.js';
import type { WorkflowFile } from '../../src/workflow/types.js';

// ── Event types ──────────────────────────────────────────────────────────────
const PR_STARTED = 'dev.cdevents.pipelinerun.started.0.3.0';
const TICKET_CREATED = 'dev.cdevents.ticket.created.0.2.0';
const TICKET_UPDATED = 'dev.cdevents.ticket.updated.0.2.0';
const TASKRUN_STARTED = 'dev.cdevents.taskrun.started.0.3.0';
const SERVICE_DEPLOYED = 'dev.cdevents.service.deployed.0.3.0';
const TASKRUN_FINISHED = 'dev.cdevents.taskrun.finished.0.3.0';
const PR_FINISHED = 'dev.cdevents.pipelinerun.finished.0.3.0';
const ARTIFACT_SIGNED = 'dev.cdevents.artifact.signed.0.3.0';
const TESTOUTPUT_PUBLISHED = 'dev.cdevents.testoutput.published.0.3.0';
const TS_QUEUED = 'dev.cdevents.testsuiterun.queued.0.3.0';
const TS_STARTED = 'dev.cdevents.testsuiterun.started.0.3.0';
const TS_FINISHED = 'dev.cdevents.testsuiterun.finished.0.3.0';
const TC_QUEUED = 'dev.cdevents.testcaserun.queued.0.3.0';
const TC_STARTED = 'dev.cdevents.testcaserun.started.0.3.0';
const TC_FINISHED = 'dev.cdevents.testcaserun.finished.0.3.0';

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
    hintFindings: () => [],
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

  it('resolves nested-form spawn as one Blocking chain per inner list (s axis)', () => {
    // RFC §4.7 nested form — the verify-spawn golden shape: two Blocking
    // chains under testsuiterun.started, anchors p1.s0/p1.s1, members on a
    // p-run beneath each anchor. The emitter gives each its own chainId; the
    // wait is receiver-side rollup (producer-side wait lands in Phase 2).
    const wf = workflow([
      { event: TS_QUEUED },
      {
        event: TS_STARTED,
        spawn: [
          [{ event: TC_QUEUED }, { event: TC_STARTED }, { event: TC_FINISHED }],
          [{ event: TC_QUEUED }, { event: TC_STARTED }, { event: TC_FINISHED }],
        ],
      },
      { event: TS_FINISHED },
    ]);

    const main = resolveChainTree(wf, makeRegistry([]));

    // Main chain is the suite spine ONLY — spawned chains are not inlined.
    expect(main.events.map((e) => e.type)).toEqual([TS_QUEUED, TS_STARTED, TS_FINISHED]);
    expect(main.events.map((e) => e.treePath)).toEqual(['p0', 'p1', 'p2']);

    expect(main.spawns).toHaveLength(2);
    const [s0, s1] = main.spawns;
    expect([s0.role, s1.role]).toEqual(['blocking', 'blocking']);
    expect(s0.chainRef).toBe('p1.s0');
    expect(s1.chainRef).toBe('p1.s1');
    expect(s0.anchorPath).toBe('p1'); // spawned by testsuiterun.started
    expect(s0.parentChainRef).toBe('root');
    expect(s0.linkKind).toBe('TRIGGER');

    expect(s0.events.map((e) => e.type)).toEqual([TC_QUEUED, TC_STARTED, TC_FINISHED]);
    expect(s0.events.map((e) => e.treePath)).toEqual(['p1.s0.p0', 'p1.s0.p1', 'p1.s0.p2']);
    expect(s1.events.map((e) => e.treePath)).toEqual(['p1.s1.p0', 'p1.s1.p1', 'p1.s1.p2']);
    // Content-identical siblings disambiguated by chainRef, never by content.
    expect(s0.events.map((e) => e.type)).toEqual(s1.events.map((e) => e.type));
  });

  it('resolves flat-form spawn as ONE Blocking chain anchored P.s', () => {
    const wf = workflow([
      {
        event: TS_STARTED,
        spawn: [{ event: TC_QUEUED }, { event: TC_STARTED }, { event: TC_FINISHED }],
      },
      { event: TS_FINISHED },
    ]);

    const main = resolveChainTree(wf, makeRegistry([]));
    expect(main.spawns).toHaveLength(1);
    const s = main.spawns[0];
    expect(s.role).toBe('blocking');
    expect(s.chainRef).toBe('p0.s');
    expect(s.events.map((e) => e.treePath)).toEqual(['p0.s0', 'p0.s1', 'p0.s2']);
  });

  it('resolves nested-form detach as one Detached chain per inner list (d{i} anchors)', () => {
    // RFC §4.8 nested form — the build-store-notify golden shape.
    const reg = makeRegistry([
      bundle('async-scan', [{ event: ARTIFACT_SIGNED }, { event: TESTOUTPUT_PUBLISHED }]),
    ]);
    const wf = workflow([
      {
        event: SERVICE_DEPLOYED,
        detach: [
          [{ event: TICKET_CREATED }, { event: TICKET_UPDATED }],
          [{ expression: 'async-scan' }],
        ],
      },
      { event: TASKRUN_FINISHED },
    ]);

    const main = resolveChainTree(wf, reg);
    expect(main.spawns).toHaveLength(2);
    const [d0, d1] = main.spawns;
    expect([d0.role, d1.role]).toEqual(['detached', 'detached']);
    expect(d0.chainRef).toBe('p0.d0');
    expect(d1.chainRef).toBe('p0.d1');
    expect(d0.events.map((e) => e.treePath)).toEqual(['p0.d0.p0', 'p0.d0.p1']);
    // Expression entry is structural: its events nest beneath its slot.
    expect(d1.events.map((e) => e.treePath)).toEqual(['p0.d1.p0.p0', 'p0.d1.p0.p1']);
  });

  it('rejects a mixed flat/nested spawn or detach list', () => {
    const mixed = workflow([
      {
        event: TS_STARTED,
        spawn: [{ event: TC_QUEUED }, [{ event: TC_STARTED }]],
      },
    ]);
    expect(() => resolveChainTree(mixed, makeRegistry([]))).toThrow(/mixes flat and nested forms/);
  });

  it('rejects a nested list at a chain position with a migration hint', () => {
    const oldGrammar = workflow([
      { event: TS_QUEUED },
      { event: TS_STARTED, produces: [[{ event: TC_QUEUED }]] },
    ]);
    expect(() => resolveChainTree(oldGrammar, makeRegistry([]))).toThrow(
      /'spawn:' \(Blocking\) or 'detach:' \(Detached\)/,
    );
  });

  it('rejects chain-bearing keys on an expression reference', () => {
    const reg = makeRegistry([bundle('ticket-associate', [{ event: TICKET_CREATED }])]);
    const wf = workflow([
      { expression: 'ticket-associate', detach: [{ event: TICKET_UPDATED }] } as never,
    ]);
    expect(() => resolveChainTree(wf, reg)).toThrow(/must not carry 'detach'/);
  });
});

// ── edge and error paths (beyond the happy path) ──────────────────────────────

describe('resolveChainTree — edge and error paths', () => {
  it('rejects a top-level nested list with a "top level" location in the message', () => {
    const wf = workflow([[{ event: TS_QUEUED }]] as unknown[]);
    expect(() => resolveChainTree(wf, makeRegistry([]))).toThrow(/top level \(item 0\)/);
  });

  it('rejects a mixed flat/nested DETACH list (mirror of the spawn rule)', () => {
    const mixed = workflow([
      { event: TS_STARTED, detach: [{ event: TC_QUEUED }, [{ event: TC_STARTED }]] },
    ]);
    expect(() => resolveChainTree(mixed, makeRegistry([]))).toThrow(
      /'detach' at p0 mixes flat and nested forms/,
    );
  });

  it("rejects 'produces' and 'spawn' on expression references too", () => {
    const reg = makeRegistry([bundle('ticket-associate', [{ event: TICKET_CREATED }])]);
    const withProduces = workflow([
      { expression: 'ticket-associate', produces: [{ event: TICKET_UPDATED }] } as never,
    ]);
    expect(() => resolveChainTree(withProduces, reg)).toThrow(/must not carry 'produces'/);
    const withSpawn = workflow([
      { expression: 'ticket-associate', spawn: [{ event: TICKET_UPDATED }] } as never,
    ]);
    expect(() => resolveChainTree(withSpawn, reg)).toThrow(/must not carry 'spawn'/);
  });

  it('carries `as:` anchors onto resolved events, including inside spawned chains', () => {
    const wf = workflow([
      { event: TS_QUEUED, as: 'suite-queued' },
      {
        event: TS_STARTED,
        spawn: [[{ event: TC_FINISHED, as: 'case-done' }]],
        detach: [{ event: TICKET_CREATED, as: 'audit-open' }],
      },
    ]);
    const main = resolveChainTree(wf, makeRegistry([]));
    expect(main.events[0].as).toBe('suite-queued');
    expect(main.events[1].as).toBeUndefined();
    const spawnChain = main.spawns.find((c) => c.role === 'blocking')!;
    expect(spawnChain.events[0].as).toBe('case-done');
    const detChain = main.spawns.find((c) => c.role === 'detached')!;
    expect(detChain.events[0].as).toBe('audit-open');
  });

  it('cascades workflow defaults and event bindings into spawned chains', () => {
    const wf = workflow([
      {
        event: TS_STARTED,
        spawn: [{ event: TC_STARTED }, { event: TC_FINISHED, tool: 'override-tool' }],
      },
    ]);
    (wf.workflow as { defaults: Record<string, unknown> }).defaults = {
      tool: 'default-tool',
      timeout_ms: 777,
      min_wait_ms: 7,
    };
    const main = resolveChainTree(wf, makeRegistry([]));
    const spawn = main.spawns[0];
    expect(spawn.events[0].tool).toBe('default-tool'); // defaults reach spawn members
    expect(spawn.events[0].timeout_ms).toBe(777);
    expect(spawn.events[1].tool).toBe('override-tool'); // item-level wins
  });

  it('resolves a spawn declared by an event INSIDE a detached chain (recursion)', () => {
    const wf = workflow([
      {
        event: TS_STARTED,
        detach: [{ event: TC_STARTED, spawn: [{ event: TC_FINISHED }] }],
      },
    ]);
    const main = resolveChainTree(wf, makeRegistry([]));
    const det = main.spawns[0];
    expect(det.role).toBe('detached');
    expect(det.chainRef).toBe('p0.d');
    expect(det.spawns).toHaveLength(1);
    const inner = det.spawns[0];
    expect(inner.role).toBe('blocking');
    expect(inner.chainRef).toBe('p0.d0.s'); // anchored at the detached member
    expect(inner.parentChainRef).toBe('p0.d');
    expect(inner.events.map((e) => e.treePath)).toEqual(['p0.d0.s0']);
  });

  it('merges subject content over item content and defaults, and honors subject.id', () => {
    const wf = workflow([
      {
        event: TS_STARTED,
        content: { a: 'item', b: 'item' },
        subject: { id: 'my-subject', content: { b: 'subject' } },
      },
      { event: TS_FINISHED },
    ]);
    (wf.workflow as { defaults: Record<string, unknown> }).defaults = {
      content: { a: 'default', c: 'default' },
    };
    const main = resolveChainTree(wf, makeRegistry([]));
    // subject.content REPLACES item content in the merge slot (not merged with it),
    // then overlays defaults: a falls back to defaults, b comes from subject.
    expect(main.events[0].subject.id).toBe('my-subject');
    expect(main.events[0].subject.content).toEqual({ a: 'default', c: 'default', b: 'subject' });
    // defaults.content cascades to every event; id falls back to the slug.
    expect(main.events[1].subject.content).toEqual({ a: 'default', c: 'default' });
    expect(main.events[1].subject.id).toBe('testsuiterun-finished');
  });

  it('leaves subject.content undefined when no content exists anywhere', () => {
    const main = resolveChainTree(workflow([{ event: TS_FINISHED }]), makeRegistry([]));
    expect(main.events[0].subject.content).toBeUndefined();
    expect(main.events[0].subject.id).toBe('testsuiterun-finished');
  });
});
