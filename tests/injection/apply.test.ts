import { describe, it, expect } from 'vitest';
import { applyInjections } from '../../src/injection/apply.js';
import { parseInjections } from '../../src/injection/parser.js';
import type { Manifest, ManifestEvent } from '../../src/manifest/types.js';

function makeManifest(eventIds: string[]): Manifest {
  const events: ManifestEvent[] = eventIds.map((id, i) => ({
    eventId: `uuid-${i}`,
    workflowEventId: id,
    type: `dev.cdevents.test.${id}`,
    stageId: 'test-stage',
    stageTool: 'test-tool',
    concurrent: false,
    source: 'test/source',
    chainId: 'test-chain',
    targetEmitTime: Date.now() + i * 1000,
    payload: {
      context: {
        specversion: '0.5.1',
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
