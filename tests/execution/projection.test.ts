/**
 * The inquiry projection (docs/EXECUTION-INQUIRY.md §2): status derivation and
 * — the load-bearing part — the line between an event that was WITHHELD
 * (produced, deliberately not sent, safe to backfill) and one that was NEVER
 * REACHED (the run died first, backfilling it would be fiction). Both look
 * like "no event arrived" to Conduit; only the first may be backfilled.
 */
import { describe, it, expect } from 'vitest';
import { ExecutionStore } from '../../src/execution/store.js';
import { projectExecution, deriveStatus } from '../../src/execution/projection.js';
import type { Manifest, ManifestEvent } from '../../src/manifest/types.js';

const T0 = 1_000_000;

function event(id: string, at: number, overrides: Partial<ManifestEvent> = {}): ManifestEvent {
  return {
    eventId: id,
    workflowEventId: id,
    treePath: `p${id}`,
    type: `dev.cdevents.build.started.0.3.0`,
    stageId: '',
    stageTool: 'jenkins',
    source: 'https://jenkins.example/',
    chainId: 'chain-1',
    targetBus: 'default',
    targetEmitTime: at,
    timeoutMs: 5000,
    payload: {
      context: {
        specversion: '0.6.0-draft',
        id,
        source: 'https://jenkins.example/',
        type: 'dev.cdevents.build.started.0.3.0',
        timestamp: new Date(at).toISOString(),
      },
      subject: { id, content: {} },
    },
    injections: [],
    isLast: false,
    emitStatus: 'pending',
    ...overrides,
  };
}

function manifestOf(events: ManifestEvent[], extra: Partial<Manifest> = {}): Manifest {
  return {
    runId: 'run-1',
    workflowId: 'wf',
    workflowName: 'wf',
    chainId: 'chain-1',
    chainIdSource: 'fallback',
    createdAt: new Date(T0).toISOString(),
    events,
    ...extra,
  };
}

function recordOf(events: ManifestEvent[], extra: Partial<Manifest> = {}) {
  const store = new ExecutionStore({ now: () => T0 });
  return store.open('exec-1', 'wf', manifestOf(events, extra));
}

describe('deriveStatus', () => {
  it('is queued before anything is emitted, running once something is', () => {
    const pending = recordOf([event('a', T0), event('b', T0 + 1)]);
    expect(deriveStatus(pending)).toBe('queued');

    const started = recordOf([event('a', T0, { emitStatus: 'emitted' }), event('b', T0 + 1)]);
    expect(deriveStatus(started)).toBe('running');
  });

  it('is finished once closed, and a WITHHELD event does not make it failed', () => {
    const store = new ExecutionStore({ now: () => T0 });
    store.open(
      'exec-1',
      'wf',
      manifestOf([
        event('a', T0, { emitStatus: 'emitted' }),
        event('b', T0 + 1, { emitStatus: 'skipped' }),
      ]),
    );
    store.close('exec-1');
    const found = store.get('exec-1');
    if (found.outcome !== 'found') throw new Error('record missing');
    expect(deriveStatus(found.record)).toBe('finished');
  });

  it('is failed when an emission errored', () => {
    const errored = recordOf([
      event('a', T0, { emitStatus: 'emitted' }),
      event('b', T0 + 1, { emitStatus: 'error', emitError: 'bus refused' }),
    ]);
    expect(deriveStatus(errored)).toBe('failed');
  });
});

describe('projectExecution — withheld vs never reached', () => {
  it('puts a deliberately suppressed event in withheld, with its full envelope', () => {
    const record = recordOf([
      event('a', T0, { emitStatus: 'emitted' }),
      event('b', T0 + 100, {
        emitStatus: 'skipped',
        injections: [{ type: 'missing', spec: 'missing:b', applied: true }],
      }),
    ]);
    const out = projectExecution(record);

    expect(out.withheld).toHaveLength(1);
    expect(out.withheld[0].context.id).toBe('b'); // the real, complete envelope
    expect(out.emitted.map((p) => p.context.id)).toEqual(['a']);
    expect(out.detail.events[1]).toMatchObject({ status: 'withheld' });
    expect(out.detail.events[1].reason).toMatch(/deliberately not sent.*missing:b/);
  });

  it('does NOT put a never-reached event in withheld when the run aborted', () => {
    const record = recordOf([
      event('a', T0, { emitStatus: 'emitted' }),
      event('b', T0 + 100, { emitStatus: 'error', emitError: 'bus refused' }),
      event('c', T0 + 200), // never got its turn
    ]);
    const out = projectExecution(record);

    expect(out.status).toBe('failed');
    expect(out.withheld).toHaveLength(0); // nothing is backfillable here
    expect(out.detail.events[2]).toMatchObject({ status: 'pending' });
    expect(out.detail.events[2].reason).toMatch(/not reached: the execution aborted/);
  });

  it('explains a still-pending event by its scheduled time (the late-injection case)', () => {
    const record = recordOf([
      event('a', T0, { emitStatus: 'emitted' }),
      event('b', T0 + 150_000, {
        injections: [{ type: 'late', spec: 'late:b:150000', applied: true }],
      }),
    ]);
    const out = projectExecution(record);

    expect(out.status).toBe('running');
    expect(out.detail.events[1].reason).toMatch(/scheduled for .*late:b:150000/);
  });

  it('orders emitted and withheld by planned time, so "first withheld" is earliest due', () => {
    const record = recordOf([
      event('late-one', T0 + 900, { emitStatus: 'skipped' }),
      event('early-one', T0 + 100, { emitStatus: 'skipped' }),
    ]);
    expect(projectExecution(record).withheld.map((p) => p.context.id)).toEqual([
      'early-one',
      'late-one',
    ]);
  });

  it('spans spawned chains, and surfaces the registered identifiers as evidence', () => {
    const record = recordOf([event('a', T0, { emitStatus: 'emitted' })], {
      chainIdSource: 'conduit',
      chainId: 'run-from-conduit',
      instanceId: 'conduitd:u@h:9:aa',
      detachedChains: [
        {
          role: 'detached',
          chainRef: 'p0.d',
          chainId: 'chain-2',
          chainIdSource: 'conduit',
          parentChainId: 'chain-1',
          parentChainRef: 'root',
          parentEventId: 'a',
          linkKind: 'TRIGGER',
          events: [event('d0', T0 + 50, { emitStatus: 'skipped' })],
        },
      ],
    });
    const out = projectExecution(record);

    expect(out.withheld.map((p) => p.context.id)).toEqual(['d0']); // spawned chain included
    expect(out.detail.runId).toBe('run-from-conduit');
    expect(out.detail.instanceId).toBe('conduitd:u@h:9:aa');
  });

  it('omits runId when no daemon minted one (offline run)', () => {
    const out = projectExecution(recordOf([event('a', T0)]));
    expect(out.detail.runId).toBeUndefined();
  });
});
