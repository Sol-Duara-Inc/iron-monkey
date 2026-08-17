/**
 * The daemon's control plane — the path that turns an HTTP request into a run.
 * These are mostly the FAILURE cases, because the happy path is the least
 * dangerous thing here: a trigger names a FILE, so containment is a security
 * boundary, and a run that dies before recording must produce an answer rather
 * than a request that never returns.
 *
 * The runner is injected rather than module-mocked — `createControlPlane`
 * takes it as an option precisely so this boundary is testable.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import { createControlPlane } from '../../src/execution/control.js';
import { createLogger, setLogger } from '../../src/logger/index.js';
import type { RunWorkflowFn } from '../../src/execution/control.js';

setLogger(createLogger({ level: 'fatal', format: 'json' }));

/** Runs still in flight, released in afterEach so no test leaves one pending. */
const inFlight: (() => void)[] = [];
afterEach(() => inFlight.splice(0).forEach((release) => release()));

interface Spy {
  fn: RunWorkflowFn;
  calls: { source: unknown; options: Record<string, unknown> }[];
}

/** A runner that records the execution and then keeps emitting, as a real one does. */
function announcingRunner(executionID = 'exec-1'): Spy {
  const calls: Spy['calls'] = [];
  const fn: RunWorkflowFn = (source, options) => {
    calls.push({ source, options: options as unknown as Record<string, unknown> });
    (options as { onExecutionStarted?: (i: unknown) => void }).onExecutionStarted?.({
      executionID,
      workflowId: 'wf',
    });
    return new Promise<void>((resolve) => inFlight.push(resolve));
  };
  return { fn, calls };
}

/** A runner that never gets far enough to record anything. */
function failingRunner(message: string): Spy {
  const calls: Spy['calls'] = [];
  const fn: RunWorkflowFn = (source, options) => {
    calls.push({ source, options: options as unknown as Record<string, unknown> });
    return Promise.reject(new Error(message));
  };
  return { fn, calls };
}

describe('workflow-root containment (a trigger names a file)', () => {
  it('REFUSES a workflow outside the configured root, before anything runs', async () => {
    const spy = announcingRunner();
    const control = createControlPlane({ workflowRoot: '/tmp/allowed', runWorkflow: spy.fn });
    await expect(control.startRun({ workflow: '/etc/passwd' })).rejects.toThrow(
      /outside the configured workflow root/,
    );
    expect(spy.calls).toHaveLength(0);
  });

  it('REFUSES a traversal that escapes the root after resolution', async () => {
    const spy = announcingRunner();
    const control = createControlPlane({ workflowRoot: '/tmp/allowed', runWorkflow: spy.fn });
    await expect(control.startRun({ workflow: '/tmp/allowed/../secrets/wf.yaml' })).rejects.toThrow(
      /outside the configured workflow root/,
    );
    expect(spy.calls).toHaveLength(0);
  });

  it('REFUSES a sibling directory that merely shares the root prefix', async () => {
    // '/tmp/allowed-elsewhere' starts with '/tmp/allowed' as a STRING but is
    // not inside it. A prefix test without the separator would admit this.
    const spy = announcingRunner();
    const control = createControlPlane({ workflowRoot: '/tmp/allowed', runWorkflow: spy.fn });
    await expect(control.startRun({ workflow: '/tmp/allowed-elsewhere/wf.yaml' })).rejects.toThrow(
      /outside the configured workflow root/,
    );
    expect(spy.calls).toHaveLength(0);
  });

  it('admits a workflow inside the root', async () => {
    const spy = announcingRunner();
    const control = createControlPlane({ workflowRoot: '/tmp/allowed', runWorkflow: spy.fn });
    await expect(control.startRun({ workflow: '/tmp/allowed/wf.yaml' })).resolves.toMatchObject({
      executionID: 'exec-1',
    });
  });

  it('admits any readable path when no root is configured, resolved absolute', async () => {
    const spy = announcingRunner();
    const control = createControlPlane({ runWorkflow: spy.fn });
    await expect(control.startRun({ workflow: 'relative/wf.yaml' })).resolves.toMatchObject({
      executionID: 'exec-1',
    });
    expect(JSON.stringify(spy.calls[0].source)).toContain(path.resolve('relative/wf.yaml'));
  });
});

describe('a trigger that cannot start is an ANSWER, not a hang', () => {
  it('rejects with the run error when the run dies before recording', async () => {
    const control = createControlPlane({ runWorkflow: failingRunner('No bus configured.').fn });
    await expect(control.startRun({ workflow: 'wf.yaml' })).rejects.toThrow(/No bus configured/);
  });

  it('rejects when a run completes without ever recording an execution', async () => {
    // Nothing announced and the promise resolves: the caller would otherwise
    // wait forever for an id that is never coming.
    const control = createControlPlane({ runWorkflow: () => Promise.resolve() });
    await expect(control.startRun({ workflow: 'wf.yaml' })).rejects.toThrow(
      /finished without recording an execution/,
    );
  });

  it('answers as soon as the execution is recorded, NOT when the run finishes', async () => {
    const spy = announcingRunner('exec-fast'); // the run promise stays pending
    const control = createControlPlane({ runWorkflow: spy.fn });
    await expect(control.startRun({ workflow: 'wf.yaml' })).resolves.toMatchObject({
      executionID: 'exec-fast',
    });
  });
});

describe('option precedence', () => {
  it('lets the request override daemon defaults, and translates noConduit', async () => {
    const spy = announcingRunner();
    const control = createControlPlane({
      config: 'daemon.yaml',
      bus: 'daemon-bus',
      runWorkflow: spy.fn,
    });
    await control.startRun({
      workflow: 'wf.yaml',
      config: 'request.yaml',
      bus: 'request-bus',
      inject: ['missing:a'],
      interval: 25,
      seed: 7,
      noConduit: true,
    });
    expect(spy.calls[0].options).toMatchObject({
      config: 'request.yaml',
      bus: 'request-bus',
      inject: ['missing:a'],
      interval: 25,
      seed: 7,
      conduit: false, // `noConduit: true` becomes the runner's `conduit: false`
    });
  });

  it('falls back to daemon defaults, and does NOT silently disable registration', async () => {
    const spy = announcingRunner();
    const control = createControlPlane({
      config: 'daemon.yaml',
      bus: 'daemon-bus',
      runWorkflow: spy.fn,
    });
    await control.startRun({ workflow: 'wf.yaml' });
    expect(spy.calls[0].options).toMatchObject({ config: 'daemon.yaml', bus: 'daemon-bus' });
    // An absent noConduit must leave `conduit` undefined. Forcing it false
    // would skip Conduit registration for every triggered run.
    expect(spy.calls[0].options.conduit).toBeUndefined();
  });
});
