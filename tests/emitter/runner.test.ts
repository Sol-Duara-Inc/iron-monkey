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

vi.mock('../../src/links/builder.js', () => ({
  buildStandaloneEndLink: vi.fn().mockReturnValue({
    specversion: '0.5.1',
    id: 'end-link-id',
    source: 'https://example.com/',
    type: 'dev.cdevents.chain.end',
    timestamp: new Date().toISOString(),
    chainId: 'chain-1',
    lastEventId: 'last-evt',
  }),
}));

vi.mock('../../src/bus/interface.js', () => ({
  createBus: vi.fn().mockResolvedValue(mockBus),
}));

// ── import after mocks ────────────────────────────────────────────────────────

import { runWorkflow } from '../../src/emitter/runner.js';
import { loadConfig, resolveBusName } from '../../src/config/loader.js';
import { validateWorkflow } from '../../src/workflow/parser.js';
import { buildManifest } from '../../src/manifest/builder.js';
import { applyInjections } from '../../src/injection/apply.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<ManifestEvent> = {}): ManifestEvent {
  return {
    eventId: 'evt-1',
    workflowEventId: 'build-started',
    type: 'dev.cdevents.build.started.0.5.1',
    stageId: 'my-pipeline',
    stageTool: 'jenkins',
    concurrent: false,
    source: 'https://jenkins.example.com/',
    chainId: 'chain-1',
    targetBus: 'default',
    targetEmitTime: Date.now() - 1000, // in the past → no sleep
    payload: {
      context: {
        specversion: '0.5.1',
        id: 'evt-1',
        source: 'https://jenkins.example.com/',
        type: 'dev.cdevents.build.started.0.5.1',
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

  it('connects to the bus, emits all events, emits the END link, then disconnects', async () => {
    const manifest = makeManifest([makeEvent()]);
    (buildManifest as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);
    (applyInjections as ReturnType<typeof vi.fn>).mockReturnValue(manifest);

    await runWorkflow('workflow.yaml', { conduit: false });

    expect(mockBus.connect).toHaveBeenCalled();
    // one event + one END link
    expect(mockBus.emit).toHaveBeenCalledTimes(2);
    expect(mockBus.emit).toHaveBeenLastCalledWith(
      'dev.cdevents.chain.end',
      expect.any(String),
      expect.any(Object),
    );
    expect(mockBus.disconnect).toHaveBeenCalled();
  });

  it('skips events whose emitStatus is "skipped" and does not call bus.emit for them', async () => {
    const skipped = makeEvent({ eventId: 'evt-1', emitStatus: 'skipped' });
    const normal = makeEvent({
      eventId: 'evt-2',
      workflowEventId: 'build-finished',
      type: 'dev.cdevents.build.finished.0.5.1',
    });
    const manifest = makeManifest([skipped, normal]);
    (buildManifest as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);
    (applyInjections as ReturnType<typeof vi.fn>).mockReturnValue(manifest);

    await runWorkflow('workflow.yaml', { conduit: false });

    // skipped event must not appear; normal event + END link = 2 calls
    const emittedTypes = (mockBus.emit as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(emittedTypes).not.toContain(skipped.type);
    expect(emittedTypes).toContain('dev.cdevents.build.finished.0.5.1');
    expect(mockBus.emit).toHaveBeenCalledTimes(2); // normal event + END link
  });

  it('disconnects the bus even when emission throws', async () => {
    const manifest = makeManifest([makeEvent()]);
    (buildManifest as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);
    (applyInjections as ReturnType<typeof vi.fn>).mockReturnValue(manifest);
    mockBus.emit.mockRejectedValueOnce(new Error('connection lost'));

    await expect(runWorkflow('workflow.yaml', { conduit: false })).rejects.toThrow(
      'connection lost',
    );
    expect(mockBus.disconnect).toHaveBeenCalled();
  });

  it('throws when the resolved bus name is not in config', async () => {
    (resolveBusName as ReturnType<typeof vi.fn>).mockReturnValue('nonexistent');
    const manifest = makeManifest([makeEvent()]);
    (buildManifest as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);
    (applyInjections as ReturnType<typeof vi.fn>).mockReturnValue(manifest);

    await expect(runWorkflow('workflow.yaml', { conduit: false })).rejects.toThrow(
      "Bus 'nonexistent' not found",
    );
  });
});
