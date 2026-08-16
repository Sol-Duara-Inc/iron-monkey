/**
 * The inquiry HTTP surface (docs/EXECUTION-INQUIRY.md §2): routing, the
 * 404/410 distinction, auth, and the idle timer — including the rule that a
 * run in flight VETOES self-shutdown. Servers bind an ephemeral port on
 * loopback, so these run isolated and in parallel safely.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  ExecutionStore,
  INQUIRY_WINDOW_MS,
  RETENTION_SLACK_MS,
} from '../../src/execution/store.js';
import { startInquiryServer } from '../../src/execution/server.js';
import type { InquiryServer } from '../../src/execution/server.js';
import { createLogger, setLogger } from '../../src/logger/index.js';
import type { Manifest, ManifestEvent } from '../../src/manifest/types.js';

setLogger(createLogger({ level: 'fatal', format: 'json' }));

const T0 = 1_000_000;
const running: InquiryServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

async function serve(store: ExecutionStore, opts = {}): Promise<InquiryServer> {
  const server = await startInquiryServer({ store, ...opts });
  running.push(server);
  return server;
}

function event(id: string, overrides: Partial<ManifestEvent> = {}): ManifestEvent {
  return {
    eventId: id,
    workflowEventId: id,
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
        id,
        source: 'https://jenkins.example/',
        type: 'dev.cdevents.build.started.0.3.0',
        timestamp: new Date(T0).toISOString(),
      },
      subject: { id, content: {} },
    },
    injections: [],
    isLast: false,
    emitStatus: 'pending',
    ...overrides,
  };
}

function manifest(events: ManifestEvent[]): Manifest {
  return {
    runId: 'run-1',
    workflowId: 'wf',
    workflowName: 'wf',
    chainId: 'chain-1',
    chainIdSource: 'fallback',
    createdAt: new Date(T0).toISOString(),
    events,
  };
}

describe('inquiry server — routing', () => {
  it('answers a known execution with the projection', async () => {
    const store = new ExecutionStore({ now: () => T0 });
    store.open(
      'exec-1',
      'wf',
      manifest([event('a', { emitStatus: 'emitted' }), event('b', { emitStatus: 'skipped' })]),
    );
    const server = await serve(store);

    const res = await fetch(`${server.url}/api/executions/exec-1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { executionID: string; status: string; withheld: unknown[] };
    expect(body.executionID).toBe('exec-1');
    expect(body.status).toBe('running');
    expect(body.withheld).toHaveLength(1);
  });

  it('distinguishes aged-out (410) from never-known (404)', async () => {
    let now = T0;
    const store = new ExecutionStore({ capacity: 1, now: () => now });
    store.open('old', 'wf', manifest([event('a')]));
    store.close('old');
    now += 5000 + INQUIRY_WINDOW_MS + RETENTION_SLACK_MS + 1;
    store.open('new', 'wf', manifest([event('b')]));
    store.close('new');

    const server = await serve(store);
    expect((await fetch(`${server.url}/api/executions/old`)).status).toBe(410);
    expect((await fetch(`${server.url}/api/executions/never`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/executions/new`)).status).toBe(200);
  });

  it('lists executions and reports health', async () => {
    const store = new ExecutionStore({ now: () => T0 });
    store.open('exec-1', 'wf', manifest([event('a')]));
    const server = await serve(store);

    const list = (await (await fetch(`${server.url}/api/executions`)).json()) as {
      executions: { executionID: string; status: string }[];
    };
    expect(list.executions).toEqual([
      expect.objectContaining({ executionID: 'exec-1', status: 'queued' }),
    ]);

    const health = (await (await fetch(`${server.url}/healthz`)).json()) as {
      ok: boolean;
      runInFlight: boolean;
    };
    expect(health).toMatchObject({ ok: true, runInFlight: true });
  });

  it('rejects non-GET and unknown routes', async () => {
    const server = await serve(new ExecutionStore({ now: () => T0 }));
    expect((await fetch(`${server.url}/api/executions/x`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${server.url}/nope`)).status).toBe(404);
  });
});

describe('inquiry server — auth', () => {
  it('requires the configured credential, and accepts it', async () => {
    const store = new ExecutionStore({ now: () => T0 });
    store.open('exec-1', 'wf', manifest([event('a')]));
    const server = await serve(store, { token: 's3cret' });

    expect((await fetch(`${server.url}/api/executions/exec-1`)).status).toBe(401);
    expect(
      (
        await fetch(`${server.url}/api/executions/exec-1`, {
          headers: { Authorization: 'Bearer wrong' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${server.url}/api/executions/exec-1`, {
          headers: {
            Authorization: 'Bearer s3cret',
            'X-Conduit-On-Behalf-Of': 'quality-engineering/msommer',
          },
        })
      ).status,
    ).toBe(200);
  });

  it('accepts unauthenticated requests when no credential is configured', async () => {
    const server = await serve(new ExecutionStore({ now: () => T0 }));
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
  });
});

describe("inquiry server — the idle timer (IM's linger)", () => {
  it('shuts down after the quiet window when nothing is running', async () => {
    const store = new ExecutionStore({ now: () => T0 });
    store.open('done', 'wf', manifest([event('a')]));
    store.close('done');

    let shutdown = false;
    const server = await serve(store, {
      idleTimeoutMs: 60,
      onIdleShutdown: () => {
        shutdown = true;
      },
    });

    await new Promise((r) => setTimeout(r, 250));
    expect(shutdown).toBe(true);
    await expect(fetch(`${server.url}/healthz`)).rejects.toThrow(); // no longer listening
  });

  it('a run in flight VETOES shutdown — IM never exits mid-pitch', async () => {
    const store = new ExecutionStore({ now: () => T0 });
    store.open('still-running', 'wf', manifest([event('a')])); // never closed

    let shutdown = false;
    const server = await serve(store, {
      idleTimeoutMs: 60,
      onIdleShutdown: () => {
        shutdown = true;
      },
    });

    await new Promise((r) => setTimeout(r, 250));
    expect(shutdown).toBe(false);
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200); // still up
  });

  it('a request restarts the quiet window', async () => {
    const store = new ExecutionStore({ now: () => T0 });
    store.open('done', 'wf', manifest([event('a')]));
    store.close('done');

    let shutdown = false;
    const server = await serve(store, {
      idleTimeoutMs: 150,
      onIdleShutdown: () => {
        shutdown = true;
      },
    });

    await new Promise((r) => setTimeout(r, 100));
    await fetch(`${server.url}/healthz`); // resets the window
    await new Promise((r) => setTimeout(r, 100));
    expect(shutdown).toBe(false); // would have fired at 150ms without the touch
  });

  it('never shuts down when the timer is disabled', async () => {
    const store = new ExecutionStore({ now: () => T0 });
    store.open('done', 'wf', manifest([event('a')]));
    store.close('done');

    const server = await serve(store, { idleTimeoutMs: 0 });
    await new Promise((r) => setTimeout(r, 200));
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
  });
});
