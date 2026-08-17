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

describe('the daemon control plane', () => {
  const control = (started: { executionID: string; workflowId: string } | Error) => ({
    startRun: () => (started instanceof Error ? Promise.reject(started) : Promise.resolve(started)),
  });

  it('starts a run and answers 202 with the execution id', async () => {
    const server = await serve(new ExecutionStore({ now: () => T0 }), {
      control: control({ executionID: 'exec-9', workflowId: 'build-fanout' }),
    });
    const res = await fetch(`${server.url}/api/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow: 'build-fanout.yaml', inject: ['missing:artifact-signed'] }),
    });
    expect(res.status).toBe(202); // accepted, not finished — the run is under way
    expect(await res.json()).toMatchObject({ executionID: 'exec-9', status: 'accepted' });
  });

  it('reports a trigger that could not start as a 400', async () => {
    const server = await serve(new ExecutionStore({ now: () => T0 }), {
      control: control(new Error('workflow not found')),
    });
    const res = await fetch(`${server.url}/api/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow: 'nope.yaml' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'workflow not found' });
  });

  it('requires a workflow field', async () => {
    const server = await serve(new ExecutionStore({ now: () => T0 }), {
      control: control({ executionID: 'x', workflowId: 'y' }),
    });
    const res = await fetch(`${server.url}/api/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('refuses to trigger on a read-only server (run --serve)', async () => {
    const server = await serve(new ExecutionStore({ now: () => T0 })); // no control plane
    const res = await fetch(`${server.url}/api/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow: 'x.yaml' }),
    });
    expect(res.status).toBe(405);
    expect((await fetch(`${server.url}/api/control/go-dark`)).status).toBe(404);
  });

  it('goes dark with 5xx, and /healthz plus the control plane stay reachable', async () => {
    const store = new ExecutionStore({ now: () => T0 });
    store.open('exec-1', 'wf', manifest([event('a')]));
    const server = await serve(store, {
      control: control({ executionID: 'x', workflowId: 'y' }),
    });

    expect((await fetch(`${server.url}/api/executions/exec-1`)).status).toBe(200);

    const dark = await fetch(`${server.url}/api/control/go-dark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: 30 }),
    });
    expect(await dark.json()).toMatchObject({ dark: true, mode: '5xx' });

    // The inquiry route is gone...
    expect((await fetch(`${server.url}/api/executions/exec-1`)).status).toBe(503);
    // ...but the driver can still see and undo it. That asymmetry is
    // deliberate: a darkened endpoint you cannot restore is a wedged test rig.
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${server.url}/healthz`)).json()).toMatchObject({ dark: true });

    await fetch(`${server.url}/api/control/go-dark`, { method: 'DELETE' });
    expect((await fetch(`${server.url}/api/executions/exec-1`)).status).toBe(200);
  });

  it("hang mode never answers, exercising the caller's retry budget", async () => {
    const store = new ExecutionStore({ now: () => T0 });
    store.open('exec-1', 'wf', manifest([event('a')]));
    const server = await serve(store, {
      control: control({ executionID: 'x', workflowId: 'y' }),
    });

    await fetch(`${server.url}/api/control/go-dark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'hang', seconds: 30 }),
    });

    await expect(
      fetch(`${server.url}/api/executions/exec-1`, { signal: AbortSignal.timeout(300) }),
    ).rejects.toThrow();
  });
});

describe('control-plane input validation (hostile bodies)', () => {
  const control = { startRun: () => Promise.resolve({ executionID: 'x', workflowId: 'y' }) };

  it('rejects a body that is not a JSON object', async () => {
    const server = await serve(new ExecutionStore({ now: () => T0 }), { control });
    for (const body of ['[1,2,3]', '"a string"', 'null', '42']) {
      const res = await fetch(`${server.url}/api/executions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      // 400, never a 500: a malformed request is the caller's error, and an
      // unhandled throw here would take the daemon's request handler with it.
      expect([400, 500]).toContain(res.status);
      expect(res.status).toBe(400);
    }
  });

  it('rejects unparseable JSON with 400, and keeps serving afterwards', async () => {
    const server = await serve(new ExecutionStore({ now: () => T0 }), { control });
    const bad = await fetch(`${server.url}/api/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
    // The daemon must survive a bad request — the next one still works.
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
  });

  it('refuses an oversized body rather than buffering it', async () => {
    const server = await serve(new ExecutionStore({ now: () => T0 }), { control });
    const res = await fetch(`${server.url}/api/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow: 'w.yaml', pad: 'x'.repeat(70 * 1024) }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/too large/);
  });

  it('an empty body is a missing-workflow error, not a crash', async () => {
    const server = await serve(new ExecutionStore({ now: () => T0 }), { control });
    const res = await fetch(`${server.url}/api/executions`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/'workflow'.*required/);
  });

  it('rejects a non-string workflow field', async () => {
    const server = await serve(new ExecutionStore({ now: () => T0 }), { control });
    for (const workflow of [42, null, { path: 'x' }, ['x.yaml'], '']) {
      const res = await fetch(`${server.url}/api/executions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('an unknown execution id containing path characters is still just a 404', async () => {
    const server = await serve(new ExecutionStore({ now: () => T0 }), { control });
    const res = await fetch(
      `${server.url}/api/executions/${encodeURIComponent('../../etc/passwd')}`,
    );
    expect(res.status).toBe(404); // a store lookup, never a filesystem one
  });
});
