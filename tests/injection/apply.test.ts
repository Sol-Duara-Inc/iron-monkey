import { describe, it, expect } from 'vitest';
import { applyInjections } from '../../src/injection/apply.js';
import { parseInjections } from '../../src/injection/parser.js';
import type { Manifest, ManifestEvent, DetachedManifestChain } from '../../src/manifest/types.js';

function makeManifest(eventIds: string[]): Manifest {
  const events: ManifestEvent[] = eventIds.map((id, i) => ({
    eventId: `uuid-${i}`,
    workflowEventId: id,
    type: `dev.cdevents.test.${id}`,
    stageId: 'test-stage',
    stageTool: 'test-tool',
    source: 'test/source',
    chainId: 'test-chain',
    targetEmitTime: Date.now() + i * 1000,
    payload: {
      context: {
        specversion: '0.6.0-draft',
        id: `uuid-${i}`,
        source: 'test/source',
        type: `dev.cdevents.test.${id}.0.1.0`,
        timestamp: new Date().toISOString(),
        chainId: 'test-chain',
      },
      subject: { id: id, content: { outcome: 'success' } },
    },
    injections: [],
    isLast: i === eventIds.length - 1,
    emitStatus: 'pending',
  }));
  return {
    runId: 'run-1',
    workflowId: 'wf-1',
    workflowName: 'test',
    chainId: 'test-chain',
    chainIdSource: 'fallback',
    createdAt: new Date().toISOString(),
    events,
  };
}

describe('applyInjections', () => {
  it('returns manifest unchanged with no injections', () => {
    const m = makeManifest(['a', 'b', 'c']);
    const result = applyInjections(m, []);
    expect(result.events.map((e) => e.workflowEventId)).toEqual(['a', 'b', 'c']);
  });

  it('marks missing event as skipped', () => {
    const m = makeManifest(['a', 'b', 'c']);
    const result = applyInjections(m, parseInjections(['missing:b']));
    const b = result.events.find((e) => e.workflowEventId === 'b')!;
    expect(b.emitStatus).toBe('skipped');
    expect(b.injections[0].type).toBe('missing');
  });

  it('reorders events for out-of-order injection', () => {
    const m = makeManifest(['a', 'b', 'c']);
    const result = applyInjections(m, parseInjections(['out-of-order:a:2']));
    expect(result.events.map((e) => e.workflowEventId)).toEqual(['b', 'c', 'a']);
  });

  it('adds delay for late injection', () => {
    const m = makeManifest(['a', 'b']);
    const origTime = m.events[1].targetEmitTime;
    const result = applyInjections(m, parseInjections(['late:b:5000']));
    expect(result.events[1].targetEmitTime).toBe(origTime + 5000);
  });

  it('duplicates event for duplicate injection', () => {
    const m = makeManifest(['a', 'b']);
    const result = applyInjections(m, parseInjections(['duplicate:a']));
    expect(result.events).toHaveLength(3);
    expect(result.events[0].workflowEventId).toBe('a');
    expect(result.events[1].workflowEventId).toBe('a');
    expect(result.events[1].injections[0].type).toBe('duplicate');
  });

  it('applies malformed injection to event payload', () => {
    const m = makeManifest(['a']);
    const result = applyInjections(m, parseInjections(['malformed:a:broken-chainid']));
    const ctx = result.events[0].payload.context;
    expect(ctx.chainId).toBe('CORRUPTED');
  });

  it('throws when event id not found', () => {
    const m = makeManifest(['a', 'b']);
    expect(() => applyInjections(m, parseInjections(['missing:nonexistent']))).toThrow(
      'unknown event id',
    );
  });
});

/** Adds a detached sub-chain (events `x`,`y` with treePaths) onto a main manifest. */
function withDetached(main: Manifest, subIds: string[]): Manifest {
  const sub: DetachedManifestChain = {
    role: 'detached',
    chainRef: 'p1.d',
    chainId: 'sub-chain',
    chainIdSource: 'fallback',
    parentChainId: main.chainId,
    parentChainRef: 'root',
    parentEventId: main.events[main.events.length - 1].eventId,
    linkKind: 'TRIGGER',
    events: subIds.map((id, i) => ({
      eventId: `sub-uuid-${i}`,
      workflowEventId: id,
      treePath: `p1.d0.p${i}`,
      type: `dev.cdevents.test.${id}`,
      stageId: 'test-stage',
      stageTool: 'test-tool',
      source: 'test/source',
      chainId: 'sub-chain',
      targetEmitTime: Date.now() + i * 1000,
      payload: {
        context: {
          specversion: '0.6.0-draft',
          id: `sub-uuid-${i}`,
          source: 'test/source',
          type: `dev.cdevents.test.${id}.0.1.0`,
          timestamp: new Date().toISOString(),
          chainId: 'sub-chain',
        },
        subject: { id, content: { outcome: 'success' } },
      },
      injections: [],
      isLast: i === subIds.length - 1,
      emitStatus: 'pending',
    })),
  };
  return { ...main, detachedChains: [sub] };
}

describe('applyInjections — sub-chains (Chaos Monkey on detached chains)', () => {
  it('withholds (missing) a detached-chain event by workflowEventId', () => {
    const m = withDetached(makeManifest(['a', 'b']), ['x', 'y']);
    const result = applyInjections(m, parseInjections(['missing:x']));
    // Main chain untouched.
    expect(result.events.every((e) => e.emitStatus !== 'skipped')).toBe(true);
    // The detached event is skipped.
    const sx = result.detachedChains![0].events.find((e) => e.workflowEventId === 'x')!;
    expect(sx.emitStatus).toBe('skipped');
    expect(sx.injections[0].type).toBe('missing');
  });

  it('targets a detached-chain event by treePath (disambiguates collisions)', () => {
    // Same workflowEventId 'a' on both chains; treePath selects the detached one.
    const m = withDetached(makeManifest(['a', 'b']), ['a', 'y']);
    const result = applyInjections(m, parseInjections(['missing:p1.d0.p0']));
    expect(result.events.find((e) => e.workflowEventId === 'a')!.emitStatus).not.toBe('skipped');
    expect(result.detachedChains![0].events[0].emitStatus).toBe('skipped');
  });

  it('delays (late) a detached-chain event without touching the main chain', () => {
    const m = withDetached(makeManifest(['a', 'b']), ['x', 'y']);
    const orig = m.detachedChains![0].events[1].targetEmitTime;
    const result = applyInjections(m, parseInjections(['late:y:7000']));
    expect(result.detachedChains![0].events[1].targetEmitTime).toBe(orig + 7000);
  });

  it('duplicates within the detached chain (structural op stays in that chain)', () => {
    const m = withDetached(makeManifest(['a', 'b']), ['x', 'y']);
    const result = applyInjections(m, parseInjections(['duplicate:x']));
    expect(result.events).toHaveLength(2); // main unchanged
    expect(result.detachedChains![0].events.map((e) => e.workflowEventId)).toEqual(['x', 'x', 'y']);
  });

  it('does not mutate the original manifest', () => {
    const m = withDetached(makeManifest(['a', 'b']), ['x', 'y']);
    applyInjections(m, parseInjections(['missing:x']));
    expect(m.detachedChains![0].events[0].emitStatus).toBe('pending');
  });
});
