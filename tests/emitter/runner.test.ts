import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Manifest, ManifestEvent } from '../../src/manifest/types.js';

// ── hoisted mock objects (must be defined before vi.mock factories run) ───────

const mockBus = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  emit: vi.fn().mockResolvedValue(undefined),
  inspect: vi.fn(),
  purge: vi.fn(),
  disconnect: vi.fn().mockResolvedValue(undefined),
}));

// ── module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../src/config/loader.js', () => ({
  loadConfig: vi.fn(),
  resolveBusName: vi.fn().mockReturnValue('default'),
}));

vi.mock('../../src/workflow/parser.js', () => ({
  validateWorkflow: vi.fn(),
  resolveProduces: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/expressions/loader.js', () => ({
  loadExpressionRegistry: vi.fn().mockReturnValue({ resolve: vi.fn(), list: vi.fn() }),
}));

vi.mock('../../src/manifest/builder.js', () => ({
  buildManifest: vi.fn(),
}));

vi.mock('../../src/injection/parser.js', () => ({
  parseInjections: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/injection/apply.js', () => ({
  applyInjections: vi.fn((m: Manifest) => m),
}));

// Note: src/links/builder.js is NOT mocked. The runner now decorates the last
// manifest event with an END link in-process; we let the real buildEndLink
// run so we can assert the exact spec-compliant shape on the emitted payload.

vi.mock('../../src/bus/interface.js', () => ({
  createBus: vi.fn().mockResolvedValue(mockBus),
}));

// ── import after mocks ────────────────────────────────────────────────────────

import { runWorkflow, runWorkflows } from '../../src/emitter/runner.js';
import { FileWorkflowSource, WorkflowSource } from '../../src/workflow/source.js';
import { loadConfig, resolveBusName } from '../../src/config/loader.js';
import { validateWorkflow } from '../../src/workflow/parser.js';
import { buildManifest } from '../../src/manifest/builder.js';
import { applyInjections } from '../../src/injection/apply.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<ManifestEvent> = {}): ManifestEvent {
  return {
    eventId: 'evt-1',
    workflowEventId: 'build-started',
    type: 'dev.cdevents.build.started.0.3.0',
    stageId: 'my-pipeline',
    stageTool: 'jenkins',
    concurrent: false,
    source: 'https://jenkins.example.com/',
    chainId: 'chain-1',
    targetBus: 'default',
    targetEmitTime: Date.now() - 1000, // in the past → no sleep
    payload: {
      context: {
        specversion: "0.6.0-draft",
        id: 'evt-1',
        source: 'https://jenkins.example.com/',
        type: 'dev.cdevents.build.started.0.3.0',
        timestamp: new Date().toISOString(),
        chainId: 'chain-1',
      },
      subject: { id: 'sub-1', content: {} },
    },
    injections: [],
    isLast: true,
    emitStatus: 'pending',
    ...overrides,
  };
}

function makeManifest(events: ManifestEvent[]): Manifest {
  return {
    runId: 'run-1',
    workflowId: 'wf-1',
    workflowName: 'test',
    chainId: 'chain-1',
    chainIdSource: 'fallback',
    createdAt: new Date().toISOString(),
    events,
  };
}

const baseConfig = {
  buses: { default: { type: 'rabbitmq' as const, url: 'amqp://localhost' } },
  tools: {},
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe('runWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue(baseConfig);
    (resolveBusName as ReturnType<typeof vi.fn>).mockReturnValue('default');
    (validateWorkflow as ReturnType<typeof vi.fn>).mockResolvedValue({
      workflow: { id: 'wf-1', name: 'test', version: 1, produces: [] },
    });
    mockBus.connect.mockResolvedValue(undefined);
    mockBus.emit.mockResolvedValue(undefined);
    mockBus.disconnect.mockResolvedValue(undefined);
  });

  it('connects to the bus, emits all events with END link on the last, then disconnects', async () => {
    const manifest = makeManifest([makeEvent()]);
    (buildManifest as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);
    (applyInjections as ReturnType<typeof vi.fn>).mockReturnValue(manifest);

    await runWorkflow(new FileWorkflowSource('workflow.yaml'), { conduit: false });

    expect(mockBus.connect).toHaveBeenCalled();
    // exactly N events — NO separate chain.end sentinel
    expect(mockBus.emit).toHaveBeenCalledTimes(1);
    const [, , payload] = (mockBus.emit as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((payload as { context: { links?: unknown[] } }).context.links).toContainEqual({
      linkType: 'END',
      end: { contextId: manifest.events[0].eventId },
    });
    expect(mockBus.disconnect).toHaveBeenCalled();
  });

  it('does not emit a separate dev.cdevents.chain.end sentinel', async () => {
    const manifest = makeManifest([makeEvent()]);
    (buildManifest as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);
    (applyInjections as ReturnType<typeof vi.fn>).mockReturnValue(manifest);

    await runWorkflow(new FileWorkflowSource('workflow.yaml'), { conduit: false });

    const emittedTypes = (mockBus.emit as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(emittedTypes).not.toContain('dev.cdevents.chain.end');
  });

  it('decorates only the LAST event with an END link, not intermediate events', async () => {
    const first = makeEvent({ eventId: 'evt-1' });
    const second = makeEvent({
      eventId: 'evt-2',
      workflowEventId: 'build-finished',
      type: 'dev.cdevents.build.finished.0.3.0',
      payload: {
        ...makeEvent({ eventId: 'evt-2' }).payload,
        context: {
          ...makeEvent({ eventId: 'evt-2' }).payload.context,
          id: 'evt-2',
        },
      },
    });
    const manifest = makeManifest([first, second]);
    (buildManifest as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);
    (applyInjections as ReturnType<typeof vi.fn>).mockReturnValue(manifest);

    await runWorkflow(new FileWorkflowSource('workflow.yaml'), { conduit: false });

    expect(mockBus.emit).toHaveBeenCalledTimes(2);
    const calls = (mockBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const firstPayload = calls[0][2] as { context: { links?: unknown[] } };
    const lastPayload = calls[1][2] as { context: { links?: unknown[] } };

    // first event has no END link
    expect(
      (firstPayload.context.links ?? []).some(
        (l) => (l as { linkType?: string }).linkType === 'END',
      ),
    ).toBe(false);
    // last event carries the END link, self-referencing its own context.id
    expect(lastPayload.context.links).toContainEqual({
      linkType: 'END',
      end: { contextId: 'evt-2' },
    });
  });

  it('accepts a plain string path for backward compatibility', async () => {
    const manifest = makeManifest([makeEvent()]);
    (buildManifest as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);
    (applyInjections as ReturnType<typeof vi.fn>).mockReturnValue(manifest);

    // string path is wrapped in FileWorkflowSource internally
    await runWorkflow('workflow.yaml', { conduit: false });

    expect(mockBus.connect).toHaveBeenCalled();
    expect(mockBus.disconnect).toHaveBeenCalled();
  });

  it('accepts a custom WorkflowSource implementation', async () => {
    const manifest = makeManifest([makeEvent()]);
    (buildManifest as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);
    (applyInjections as ReturnType<typeof vi.fn>).mockReturnValue(manifest);

    const mockDef = { workflow: { id: 'wf-1', name: 'test', version: 1, produces: [] } };
    class StubSource extends WorkflowSource {
      get name() {
        return 'stub';
      }
      async getWorkflow() {
        return mockDef as never;
      }
    }

    await runWorkflow(new StubSource(), { conduit: false });

    // validateWorkflow must NOT have been called — source supplies the definition directly
    expect(validateWorkflow).not.toHaveBeenCalled();
    expect(mockBus.connect).toHaveBeenCalled();
  });

  it('skips events whose emitStatus is "skipped" and does not call bus.emit for them', async () => {
    const skipped = makeEvent({ eventId: 'evt-1', emitStatus: 'skipped' });
    const normal = makeEvent({
      eventId: 'evt-2',
      workflowEventId: 'build-finished',
      type: 'dev.cdevents.build.finished.0.3.0',
    });
    const manifest = makeManifest([skipped, normal]);
    (buildManifest as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);
    (applyInjections as ReturnType<typeof vi.fn>).mockReturnValue(manifest);

    await runWorkflow(new FileWorkflowSource('workflow.yaml'), { conduit: false });

    // skipped event must not appear; only the normal event is emitted (no
    // separate chain.end either — END link rides on the last manifest event)
    const emittedTypes = (mockBus.emit as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(emittedTypes).not.toContain(skipped.type);
    expect(emittedTypes).toContain('dev.cdevents.build.finished.0.3.0');
    expect(mockBus.emit).toHaveBeenCalledTimes(1);
  });

  it('disconnects the bus even when emission throws', async () => {
    const manifest = makeManifest([makeEvent()]);
    (buildManifest as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);
    (applyInjections as ReturnType<typeof vi.fn>).mockReturnValue(manifest);
    mockBus.emit.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      runWorkflow(new FileWorkflowSource('workflow.yaml'), { conduit: false }),
    ).rejects.toThrow('connection lost');
    expect(mockBus.disconnect).toHaveBeenCalled();
  });

  it('throws when the resolved bus name is not in config', async () => {
    (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ buses: {}, tools: {} });
    (resolveBusName as ReturnType<typeof vi.fn>).mockReturnValue('nonexistent');
    const manifest = makeManifest([makeEvent()]);
    (buildManifest as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);
    (applyInjections as ReturnType<typeof vi.fn>).mockReturnValue(manifest);

    await expect(
      runWorkflow(new FileWorkflowSource('workflow.yaml'), { bus: 'nonexistent', conduit: false }),
    ).rejects.toThrow("Bus 'nonexistent' not found");
  });
});

describe('runWorkflows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue(baseConfig);
    (resolveBusName as ReturnType<typeof vi.fn>).mockReturnValue('default');
    (validateWorkflow as ReturnType<typeof vi.fn>).mockResolvedValue({
      workflow: { id: 'wf-1', name: 'test', version: 1, produces: [] },
    });
    mockBus.connect.mockResolvedValue(undefined);
    mockBus.emit.mockResolvedValue(undefined);
    mockBus.disconnect.mockResolvedValue(undefined);
    const manifest = makeManifest([makeEvent()]);
    (buildManifest as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);
    (applyInjections as ReturnType<typeof vi.fn>).mockReturnValue(manifest);
  });

  it('returns an empty array when given no sources', async () => {
    const results = await runWorkflows([], { conduit: false });
    expect(results).toEqual([]);
  });

  it('returns fulfilled for every source when all workflows succeed', async () => {
    const sources = ['a.yaml', 'b.yaml', 'c.yaml'].map((p) => new FileWorkflowSource(p));
    const results = await runWorkflows(sources, { conduit: false });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(results.map((r) => r.workflowPath)).toEqual(['a.yaml', 'b.yaml', 'c.yaml']);
  });

  it('accepts plain string paths for backward compatibility', async () => {
    const results = await runWorkflows(['a.yaml', 'b.yaml'], { conduit: false });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(results.map((r) => r.workflowPath)).toEqual(['a.yaml', 'b.yaml']);
  });

  it('preserves input order in the results array', async () => {
    const sources = ['first.yaml', 'second.yaml', 'third.yaml'].map(
      (p) => new FileWorkflowSource(p),
    );
    const results = await runWorkflows(sources, { conduit: false });

    expect(results.map((r) => r.workflowPath)).toEqual(['first.yaml', 'second.yaml', 'third.yaml']);
  });

  it('derives workflowPath from source.name, not the raw path', async () => {
    const sources = [new FileWorkflowSource('/deep/path/to/my-workflow.yaml')];
    const results = await runWorkflows(sources, { conduit: false });

    expect(results[0].workflowPath).toBe('my-workflow.yaml');
  });

  it('returns a rejected result for a failed source without aborting the others', async () => {
    // second call to validateWorkflow rejects; first and third succeed
    (validateWorkflow as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ workflow: { id: 'wf-1', name: 'a', version: 1, produces: [] } })
      .mockRejectedValueOnce(new Error('bad schema'))
      .mockResolvedValueOnce({ workflow: { id: 'wf-3', name: 'c', version: 1, produces: [] } });

    const sources = ['a.yaml', 'bad.yaml', 'c.yaml'].map((p) => new FileWorkflowSource(p));
    const results = await runWorkflows(sources, { conduit: false });

    expect(results[0]).toMatchObject({ workflowPath: 'a.yaml', status: 'fulfilled' });
    expect(results[1]).toMatchObject({
      workflowPath: 'bad.yaml',
      status: 'rejected',
      error: 'bad schema',
    });
    expect(results[2]).toMatchObject({ workflowPath: 'c.yaml', status: 'fulfilled' });
  });

  it('does not include an error field on fulfilled results', async () => {
    const [result] = await runWorkflows([new FileWorkflowSource('ok.yaml')], { conduit: false });
    expect(result.status).toBe('fulfilled');
    expect(result.error).toBeUndefined();
  });

  it('fires all workflows simultaneously (each gets its own bus connection)', async () => {
    await runWorkflows(
      ['x.yaml', 'y.yaml'].map((p) => new FileWorkflowSource(p)),
      { conduit: false },
    );

    // two independent runs → connect called once per workflow
    expect(mockBus.connect).toHaveBeenCalledTimes(2);
    expect(mockBus.disconnect).toHaveBeenCalledTimes(2);
  });
});
