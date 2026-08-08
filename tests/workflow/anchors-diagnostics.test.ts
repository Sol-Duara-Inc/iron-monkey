/**
 * Phase 4 — the §4.9 anchors dictionary and the §6.2 resolution contract:
 * cycle detection (hard failure), unknown identity (hard failure), duplicate
 * mapping keys (document layer), and the MUST-report NON-FATAL diagnostics
 * (defaults conflicts where the explicit value wins; §5.4 override keys that
 * matched nothing). Semantics mirror conduit-go's transformer — the
 * reference implementation for binding behavior the goldens don't pin.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'fs';
import path from 'path';
import {
  resolveChainTree,
  resolveExpressionTree,
  resolveAnchor,
} from '../../src/workflow/chain-tree.js';
import { createRegistry } from '../../src/expressions/loader.js';
import { validateWorkflow } from '../../src/workflow/parser.js';
import { makeTmpDir } from '../helpers.js';
import type { ExpressionBundle } from '../../src/expressions/types.js';
import type { WorkflowFile } from '../../src/workflow/types.js';

const TS_STARTED = 'dev.cdevents.testsuiterun.started.0.3.0';
const TS_FINISHED = 'dev.cdevents.testsuiterun.finished.0.3.0';
const TC_STARTED = 'dev.cdevents.testcaserun.started.0.3.0';
const TC_FINISHED = 'dev.cdevents.testcaserun.finished.0.3.0';
const TICKET_CREATED = 'dev.cdevents.ticket.created.0.2.0';

const GROUP = 'qa';
const AUTHOR = 'msommer';

function bundle(expression: string, produces: ExpressionBundle['produces']): ExpressionBundle {
  return { group: GROUP, author: AUTHOR, expression, produces };
}

function workflow(produces: unknown[], defaults: Record<string, unknown> = {}): WorkflowFile {
  return {
    workflow: { id: 'wf', name: 'wf', group: GROUP, author: AUTHOR, defaults, produces },
  } as unknown as WorkflowFile;
}

describe('the §4.9 anchors dictionary', () => {
  it('collects carriers across main, spawned, and expression-expanded events in DF order', () => {
    const registry = createRegistry([bundle('verify', [{ event: TC_FINISHED, as: 'case-done' }])]);
    const root = resolveChainTree(
      workflow([
        { event: TS_STARTED, as: 'suite-live', spawn: [{ event: TC_STARTED, as: 'case-live' }] },
        { expression: 'verify' },
        { event: TS_FINISHED, as: 'suite-done' },
      ]),
      registry,
    );
    expect([...(root.anchors?.keys() ?? [])]).toEqual([
      'suite-live',
      'case-live', // spawned chain's event, at its spawning event's position
      'case-done', // declared INSIDE the expression, authoritative under this root
      'suite-done',
    ]);
    expect(resolveAnchor(root, 'case-done')[0].treePath).toBe('p1.p0');
  });

  it('a recurring anchor resolves to every carrier; a missing one to the empty list', () => {
    const registry = createRegistry([bundle('verify', [{ event: TC_FINISHED, as: 'case-done' }])]);
    const root = resolveChainTree(
      workflow([{ expression: 'verify' }, { expression: 'verify' }]),
      registry,
    );
    expect(resolveAnchor(root, 'case-done').map((e) => e.treePath)).toEqual(['p0.p0', 'p1.p0']);
    expect(resolveAnchor(root, 'nope')).toEqual([]);
  });

  it('an expression-rooted resolution carries its own authoritative anchors', () => {
    const root = resolveExpressionTree(
      bundle('verify', [{ event: TC_FINISHED, as: 'case-done' }]),
      createRegistry([]),
    );
    expect(resolveAnchor(root, 'case-done')).toHaveLength(1);
  });
});

describe('§6.2 hard failure modes', () => {
  it('reports a circular expression reference with the resolution stack', () => {
    const registry = createRegistry([
      bundle('a', [{ event: TS_STARTED }, { expression: 'b' }]),
      bundle('b', [{ expression: 'a' }]),
    ]);
    expect(() => resolveChainTree(workflow([{ expression: 'a' }]), registry)).toThrow(
      /circular expression reference: qa\/msommer\/a already on the resolution stack \(qa\/msommer\/a -> qa\/msommer\/b -> qa\/msommer\/a\)/,
    );
  });

  it('a self-reference is a cycle', () => {
    const registry = createRegistry([bundle('loop', [{ expression: 'loop' }])]);
    expect(() => resolveChainTree(workflow([{ expression: 'loop' }]), registry)).toThrow(
      /circular expression reference/,
    );
  });

  it('reports an unknown expression identity', () => {
    expect(() => resolveChainTree(workflow([{ expression: 'ghost' }]), createRegistry([]))).toThrow(
      /Unknown expression identity/,
    );
  });

  it('rejects duplicate mapping keys at the document layer', async () => {
    const dir = await makeTmpDir('dup-keys');
    const p = path.join(dir, 'dup.workflow.yaml');
    writeFileSync(
      p,
      [
        'workflow:',
        '  id: dup',
        '  name: dup',
        '  name: dup-again', // duplicate key
        '  produces:',
        `    - event: ${TS_STARTED}`,
      ].join('\n'),
    );
    await expect(validateWorkflow(p)).rejects.toThrow(/duplicated mapping key/);
  });
});

describe('§6.2 MUST-report diagnostics (non-fatal)', () => {
  it('reports a default colliding with an event-explicit value; the explicit value wins', () => {
    const root = resolveChainTree(
      workflow([{ event: TS_STARTED, tool: 'spinnaker' }, { event: TS_FINISHED }], {
        tool: 'jenkins',
      }),
      createRegistry([]),
    );
    expect(root.diagnostics).toEqual([
      'conflicting binding: tool set in defaults and explicitly on p0; the explicit value wins (§5.3)',
    ]);
    expect(root.events[0].tool).toBe('spinnaker'); // explicit wins
    expect(root.events[1].tool).toBe('jenkins'); // default fills the silent one
  });

  it('reference-level bindings count as explicit for conflict purposes', () => {
    const registry = createRegistry([bundle('verify', [{ event: TC_FINISHED }])]);
    const root = resolveChainTree(
      workflow([{ expression: 'verify', tool: 'spinnaker' }], { tool: 'jenkins' }),
      registry,
    );
    expect(root.diagnostics).toEqual([
      'conflicting binding: tool set in defaults and explicitly on p0.p0; the explicit value wins (§5.3)',
    ]);
    expect(root.events[0].tool).toBe('spinnaker');
  });

  it('an override-sourced value is exempt from conflict reporting', () => {
    const registry = createRegistry([bundle('verify', [{ event: TC_FINISHED }])]);
    const root = resolveChainTree(
      workflow(
        [
          {
            expression: 'verify',
            overrides: { 'dev.cdevents.testcaserun.finished': { tool: 'gke-prod' } },
          },
        ],
        { tool: 'jenkins' },
      ),
      registry,
    );
    expect(root.diagnostics).toEqual([]); // override is sanctioned shadowing, not a collision
    expect(root.events[0].tool).toBe('gke-prod');
  });

  it('reports §5.4 override keys that matched no event in their resolved subtree', () => {
    const registry = createRegistry([bundle('verify', [{ event: TC_FINISHED }])]);
    const root = resolveChainTree(
      workflow([
        {
          expression: 'verify',
          overrides: {
            'dev.cdevents.build.started': { tool: 'jenkins' }, // wrong subject
            'dev.cdevents.testcaserun.finished:9.9.9': { tool: 'x' }, // wrong version
            'testcaserun.finished': { tool: 'y' }, // malformed (not a §6.1 form)
            'dev.cdevents.testcaserun.finished': { tool: 'gke-prod' }, // matches
          },
        },
      ]),
      registry,
    );
    expect(root.diagnostics).toEqual([
      'override key "dev.cdevents.build.started" on reference verify matched no event in its resolved subtree',
      'override key "dev.cdevents.testcaserun.finished:9.9.9" on reference verify matched no event in its resolved subtree',
      'override key "testcaserun.finished" on reference verify matched no event in its resolved subtree',
    ]);
    expect(root.events[0].tool).toBe('gke-prod');
  });
});

describe('§5.4 override keys match by resolved type identity', () => {
  const registry = () =>
    createRegistry([
      bundle('mixed', [
        { event: 'dev.cdevents.testcaserun.finished' }, // versionless → 0.3.0
        { event: TICKET_CREATED },
        { event: 'dev.cdeventsx.mytool-scan.completed' },
      ]),
    ]);

  it('a versionless key matches any resolved version; colon and embedded spellings are equivalent', () => {
    const root = resolveChainTree(
      workflow([
        {
          expression: 'mixed',
          overrides: {
            'dev.cdevents.testcaserun.finished': { tool: 'a' },
            'dev.cdevents.ticket.created:0.2.0': { tool: 'b' }, // colon key ≡ embedded resolution
          },
        },
      ]),
      registry(),
    );
    expect(root.events[0].tool).toBe('a');
    expect(root.events[1].tool).toBe('b');
    expect(root.diagnostics).toEqual([]);
  });

  it('a versioned key must equal the resolved version', () => {
    const root = resolveChainTree(
      workflow([
        {
          expression: 'mixed',
          overrides: { 'dev.cdevents.testcaserun.finished.0.2.0': { tool: 'old' } },
        },
      ]),
      registry(),
    );
    expect(root.events[0].tool).toBe(''); // resolved 0.3.0 ≠ key's 0.2.0
    expect(root.diagnostics?.[0]).toMatch(/matched no event/);
  });

  it('namespaces never cross, and extension events match their authored spelling', () => {
    const root = resolveChainTree(
      workflow([
        {
          expression: 'mixed',
          overrides: {
            'dev.cdevents.mytool-scan.completed': { tool: 'wrong-ns' },
            'dev.cdeventsx.mytool-scan.completed': { tool: 'scanner' },
          },
        },
      ]),
      registry(),
    );
    expect(root.events[2].tool).toBe('scanner');
    expect(root.diagnostics).toEqual([
      'override key "dev.cdevents.mytool-scan.completed" on reference mixed matched no event in its resolved subtree',
    ]);
  });

  it('workflowEventId no longer serves as an override key (canonical semantics)', () => {
    const root = resolveChainTree(
      workflow([{ expression: 'mixed', overrides: { 'testcaserun-finished': { tool: 'by-id' } } }]),
      registry(),
    );
    expect(root.events[0].tool).toBe('');
    expect(root.diagnostics?.[0]).toContain('"testcaserun-finished"');
  });
});
