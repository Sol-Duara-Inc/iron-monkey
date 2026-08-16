/**
 * The execution store's two retention rules (docs/EXECUTION-INQUIRY.md, F2):
 * capacity is a FLOOR — a record still inside its inquiry window is never
 * evicted, even past capacity — and an open run is never evictable. The
 * clock is injected so none of this depends on wall time.
 */
import { describe, it, expect } from 'vitest';
import {
  ExecutionStore,
  INQUIRY_WINDOW_MS,
  RETENTION_SLACK_MS,
  allEvents,
} from '../../src/execution/store.js';
import type { Manifest, ManifestEvent } from '../../src/manifest/types.js';

const T0 = 1_000_000;

function event(overrides: Partial<ManifestEvent> = {}): ManifestEvent {
  return {
    eventId: 'e1',
    workflowEventId: 'build-started',
    treePath: 'p0',
    type: 'dev.cdevents.build.started.0.3.0',
    stageId: '',
    stageTool: 'jenkins',
    source: 'https://jenkins.example/',
    chainId: 'chain-1',
    targetBus: 'default',
    targetEmitTime: T0,
    timeoutMs: 5000,
    payload: {
      context: {
        specversion: '0.6.0-draft',
        id: 'e1',
        source: 'https://jenkins.example/',
        type: 'dev.cdevents.build.started.0.3.0',
        timestamp: new Date(T0).toISOString(),
      },
      subject: { id: 'build-started', content: {} },
    },
    injections: [],
    isLast: false,
    emitStatus: 'pending',
    ...overrides,
  };
}

function manifest(ttls: number[], detachedTtls: number[] = []): Manifest {
  return {
    runId: 'run-1',
    workflowId: 'wf',
    workflowName: 'wf',
    chainId: 'chain-1',
    chainIdSource: 'fallback',
    createdAt: new Date(T0).toISOString(),
    events: ttls.map((t, i) => event({ eventId: `e${i}`, timeoutMs: t })),
    detachedChains:
      detachedTtls.length === 0
        ? undefined
        : [
            {
              role: 'detached',
              chainRef: 'p0.d',
              chainId: 'chain-2',
              chainIdSource: 'fallback',
              parentChainId: 'chain-1',
              parentChainRef: 'root',
              parentEventId: 'e0',
              linkKind: 'TRIGGER',
              events: detachedTtls.map((t, i) => event({ eventId: `d${i}`, timeoutMs: t })),
            },
          ],
  };
}

describe('ExecutionStore — retention', () => {
  it('never evicts a record still inside its inquiry window, even past capacity', () => {
    let now = T0;
    const store = new ExecutionStore({ capacity: 2, now: () => now });

    for (let i = 0; i < 5; i++) {
      store.open(`x${i}`, 'wf', manifest([1_200_000])); // 20-minute budget
      store.close(`x${i}`);
      now += 1000; // runs land a second apart
    }

    // Capacity says 2; every window is open, so all five are retained.
    expect(store.size()).toBe(5);
    expect(store.get('x0').outcome).toBe('found');
  });

  it('evicts oldest-first once windows have closed, and answers 410 for those', () => {
    let now = T0;
    const store = new ExecutionStore({ capacity: 2, now: () => now });

    store.open('old', 'wf', manifest([5000]));
    store.close('old');
    const window = 5000 + INQUIRY_WINDOW_MS + RETENTION_SLACK_MS;

    now += window + 1; // 'old' is now past its window
    for (const id of ['a', 'b', 'c']) {
      store.open(id, 'wf', manifest([5000]));
      store.close(id);
    }

    expect(store.get('old')).toEqual({ outcome: 'gone' }); // known, aged out → 410
    expect(store.get('never-existed')).toEqual({ outcome: 'unknown' }); // → 404
    // Only the out-of-window record went. a/b/c are all still inquiry-eligible,
    // so the store sits ABOVE capacity — the floor yielding to the window.
    expect(store.size()).toBe(3);
    expect(['a', 'b', 'c'].map((id) => store.get(id).outcome)).toEqual(['found', 'found', 'found']);
  });

  it('never evicts an OPEN run, however far past capacity', () => {
    let now = T0;
    const store = new ExecutionStore({ capacity: 1, now: () => now });

    store.open('running-1', 'wf', manifest([5000]));
    store.open('running-2', 'wf', manifest([5000]));
    now += 10 * 60_000;
    store.open('running-3', 'wf', manifest([5000]));

    expect(store.size()).toBe(3);
    expect(store.get('running-1').outcome).toBe('found');
  });

  it('measures the window against the LONGEST budget in the run, spawned chains included', () => {
    let now = T0;
    const store = new ExecutionStore({ capacity: 1, now: () => now });

    // Main chain's budgets are small; a detached chain carries the long one.
    store.open('long', 'wf', manifest([5000], [1_200_000]));
    store.close('long');

    now += 5000 + INQUIRY_WINDOW_MS + RETENTION_SLACK_MS + 1; // past the SHORT budget
    store.open('next', 'wf', manifest([5000]));
    store.close('next');

    // Still retained: the detached chain's 20-minute budget governs.
    expect(store.get('long').outcome).toBe('found');
  });

  it('records the failure that ended a run', () => {
    const store = new ExecutionStore({ now: () => T0 });
    store.open('x', 'wf', manifest([5000]));
    store.close('x', 'bus refused connection');
    const found = store.get('x');
    expect(found.outcome).toBe('found');
    if (found.outcome === 'found') expect(found.record.failure).toBe('bus refused connection');
  });
});

describe('allEvents', () => {
  it('spans the main chain and every spawned chain', () => {
    expect(allEvents(manifest([1, 2], [3, 4, 5]))).toHaveLength(5);
  });
});
