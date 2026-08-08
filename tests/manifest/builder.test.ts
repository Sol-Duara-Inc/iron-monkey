import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildManifest } from '../../src/manifest/builder.js';
import { validateWorkflow } from '../../src/workflow/parser.js';
import { resolveChainTree } from '../../src/workflow/chain-tree.js';
import { loadExpressionRegistry } from '../../src/expressions/loader.js';
import type { ResolvedEvent } from '../../src/workflow/parser.js';
import type { IronMonkeyConfig } from '../../src/config/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(__dirname, '../../schemas/cdevents');
const EXPRESSIONS_DIR = path.resolve(__dirname, '../../expressions');
const WORKFLOWS_DIR = path.resolve(__dirname, '../../examples/workflows');

const singleEvent: ResolvedEvent = {
  id: 'build-started',
  type: 'dev.cdevents.build.started.0.3.0',
  tool: 'jenkins',
  source: '',
  pipeline: 'my-pipeline',
  timeout_ms: 1000,
  min_wait_ms: 100,
  subject: { id: 'build-started' },
  origin: 'event',
};

const twoEvents: ResolvedEvent[] = [
  { ...singleEvent, id: 'build-started', type: 'dev.cdevents.build.started.0.3.0' },
  {
    id: 'build-finished',
    type: 'dev.cdevents.build.finished.0.3.0',
    tool: 'jenkins',
    source: '',
    pipeline: 'my-pipeline',
    timeout_ms: 100,
    min_wait_ms: 0,
    subject: { id: 'build-finished' },
    origin: 'event',
  },
];

const config: IronMonkeyConfig = {
  buses: { default: { type: 'rabbitmq', url: 'amqp://localhost' } },
  tools: { jenkins: { source: 'dev/jenkins' } },
  schemasPath: SCHEMAS_DIR,
};

const meta = { id: 'test-wf', name: 'test-workflow' };

describe('buildManifest', () => {
  it('builds a manifest with the correct shape', async () => {
    const manifest = await buildManifest(meta, [singleEvent], config, { noConduit: true });

    expect(manifest.workflowId).toBe('test-wf');
    expect(manifest.workflowName).toBe('test-workflow');
    expect(manifest.chainIdSource).toBe('fallback');
    expect(manifest.chainId).toMatch(/^urn:sol-duara:fallback:/);
    expect(manifest.events).toHaveLength(1);
  });

  it('sets targetBus on every manifest entry', async () => {
    const manifest = await buildManifest(meta, [singleEvent], config, {
      noConduit: true,
      busName: 'my-bus',
    });
    expect(manifest.events.every((e) => e.targetBus === 'my-bus')).toBe(true);
  });

  it('defaults targetBus to "default" when busName is not provided', async () => {
    const manifest = await buildManifest(meta, [singleEvent], config, { noConduit: true });
    expect(manifest.events[0].targetBus).toBe('default');
  });

  it('marks the last event as isLast', async () => {
    const manifest = await buildManifest(meta, twoEvents, config, { noConduit: true });
    expect(manifest.events[manifest.events.length - 1].isLast).toBe(true);
    expect(manifest.events[0].isLast).toBe(false);
  });

  it('produces deterministic IDs with a seed', async () => {
    const m1 = await buildManifest(meta, [singleEvent], config, { noConduit: true, seed: 42 });
    const m2 = await buildManifest(meta, [singleEvent], config, { noConduit: true, seed: 42 });
    expect(m1.events[0].eventId).toBe(m2.events[0].eventId);
  });

  it('uses the tool source from config when workflow source is blank', async () => {
    const manifest = await buildManifest(meta, [singleEvent], config, { noConduit: true });
    expect(manifest.events[0].source).toBe('dev/jenkins');
  });

  it('prefers workflow source over config tool source', async () => {
    const withSource: ResolvedEvent = { ...singleEvent, source: 'https://custom.example.com/' };
    const manifest = await buildManifest(meta, [withSource], config, { noConduit: true });
    expect(manifest.events[0].source).toBe('https://custom.example.com/');
  });

  it('emits specversion 0.6.0-draft in every event context', async () => {
    const manifest = await buildManifest(meta, [singleEvent], config, { noConduit: true });
    expect(manifest.events[0].payload.context.specversion).toBe('0.6.0-draft');
  });

  it('emits CDEvents-spec PATH links on the second-and-later events', async () => {
    const manifest = await buildManifest(meta, twoEvents, config, { noConduit: true });
    const links = manifest.events[1].payload.context.links;
    expect(Array.isArray(links)).toBe(true);
    expect((links as unknown[])[0]).toMatchObject({ linkType: 'PATH' });
    expect((links as unknown[])[0]).toMatchObject({
      from: { contextId: manifest.events[0].eventId },
    });
  });

  it('throws when schema is not found', async () => {
    const badEvent: ResolvedEvent = {
      ...singleEvent,
      type: 'dev.cdevents.unknown.event.9.9.9',
    };
    await expect(buildManifest(meta, [badEvent], config, { noConduit: true })).rejects.toThrow(
      'No schema found for event type',
    );
  });

  it('sets targetBus to the same value for all events in a single run', async () => {
    const manifest = await buildManifest(meta, twoEvents, config, {
      noConduit: true,
      busName: 'staging',
    });
    const buses = manifest.events.map((e) => e.targetBus);
    expect(new Set(buses).size).toBe(1);
    expect(buses[0]).toBe('staging');
  });

  it('spaces events by an exact interval when the interval override is set', async () => {
    // interval override => precise cadence, no jitter. Verify the timestamp
    // deltas across the manifest equal exactly the requested interval.
    const manifest = await buildManifest(meta, twoEvents, config, {
      noConduit: true,
      interval: 2000,
    });
    const ts = manifest.events.map((e) => Date.parse(e.payload.context.timestamp as string));
    expect(ts[1] - ts[0]).toBe(2000);
  });

  it('uses the jittered default cadence (>= 900ms) when no interval is set', async () => {
    // twoEvents declares min_wait=100/timeout=1000 then min_wait=0/timeout=100.
    // With the default policy every inter-event delay is floored at 900ms, so
    // a fixed seed yields a deterministic delta of at least the floor.
    const manifest = await buildManifest(meta, twoEvents, config, {
      noConduit: true,
      seed: 42,
    });
    const ts = manifest.events.map((e) => Date.parse(e.payload.context.timestamp as string));
    expect(ts[1] - ts[0]).toBeGreaterThanOrEqual(900);
  });
});

describe('buildManifest — real workflow end-to-end', () => {
  it('builds a schema-valid manifest from prod-auth-hotfix-fast-path.yaml', async () => {
    const wf = await validateWorkflow(path.join(WORKFLOWS_DIR, 'prod-auth-hotfix-fast-path.yaml'));
    const registry = loadExpressionRegistry(EXPRESSIONS_DIR);
    const mainChain = resolveChainTree(wf, registry);

    const cfg: IronMonkeyConfig = {
      buses: { default: { type: 'rabbitmq', url: 'amqp://localhost' } },
      tools: {
        'jenkins-prod': { source: 'https://jenkins.spin-dev.io/' },
        'gke-prod': { source: 'https://gke.spin-dev.io/auth' },
      },
      schemasPath: SCHEMAS_DIR,
    };

    const manifest = await buildManifest(
      { id: wf.workflow.id, name: wf.workflow.name },
      mainChain,
      cfg,
      { noConduit: true },
    );

    expect(manifest.workflowId).toBe('prod-auth-hotfix-fast-path');
    expect(manifest.events.length).toBeGreaterThan(5);
    expect(manifest.events[0].payload.context.specversion).toBe('0.6.0-draft');
    expect(manifest.events[manifest.events.length - 1].isLast).toBe(true);
    // Every event must have a valid payload type matching the CDEvents format
    for (const e of manifest.events) {
      expect(e.payload.context.type).toMatch(/^dev\.cdevents\./);
    }
  });
});

describe('buildManifest — chain-id acquisition without --no-conduit', () => {
  it('falls back offline when conduit is unconfigured (no daemon to answer)', async () => {
    const manifest = await buildManifest(meta, [singleEvent], config, { noConduit: false });
    expect(manifest.chainIdSource).toBe('fallback');
    expect(manifest.chainId).toMatch(/^urn:sol-duara:fallback:/);
  });
});

describe('buildManifest — batch register (Proleptic §1)', () => {
  const CONDUIT_CFG: IronMonkeyConfig = {
    buses: { default: { type: 'rabbitmq', url: 'amqp://localhost' } },
    tools: {},
    schemasPath: SCHEMAS_DIR,
    conduit: { url: 'http://conduit.example:8091' },
  };

  const registerResponse = (chainId: string) => ({
    ok: true,
    status: 200,
    json: async () => ({
      runId: chainId,
      instanceId: 'conduitd:u@h:1:boot',
      issuedAt: '2026-08-09T00:00:00Z',
      chains: [
        {
          chainRef: 'root',
          chainId,
          role: 'main',
          status: 'declared',
          parentChainId: null,
          parentChainRef: null,
          parentEventId: null,
          linkKind: null,
          expectedEvents: [
            {
              type: singleEvent.type,
              treePath: 'p0',
              order: 0,
              timeoutMs: singleEvent.timeout_ms,
            },
          ],
        },
      ],
    }),
  });

  it('uses the registered chain set: one call, server-minted id, pinned instanceId', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(registerResponse('99999999-aaaa-4bbb-8ccc-dddddddddddd')),
    );
    try {
      const manifest = await buildManifest(meta, [singleEvent], CONDUIT_CFG, { noConduit: false });
      expect(manifest.chainId).toBe('99999999-aaaa-4bbb-8ccc-dddddddddddd');
      expect(manifest.chainIdSource).toBe('conduit');
      expect(manifest.instanceId).toBe('conduitd:u@h:1:boot');
      expect(fetch).toHaveBeenCalledTimes(1); // ONE batch register, no shim loop
      const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
      expect(url).toBe('http://conduit.example:8091/api/runs');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails the run BEFORE emitting when derivations diverge (producer machine gate)', async () => {
    const diverged = registerResponse('99999999-aaaa-4bbb-8ccc-dddddddddddd');
    const body = await diverged.json();
    body.chains[0].expectedEvents[0].type = 'dev.cdevents.change.merged.0.3.0';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ...diverged, json: async () => body }));
    try {
      await expect(
        buildManifest(meta, [singleEvent], CONDUIT_CFG, { noConduit: false }),
      ).rejects.toThrow(/derivation mismatch/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back offline when no daemon answers the register', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')));
    try {
      const manifest = await buildManifest(meta, [singleEvent], CONDUIT_CFG, { noConduit: false });
      expect(manifest.chainIdSource).toBe('fallback');
      expect(manifest.chainId).toMatch(/^urn:sol-duara:fallback:/);
      expect(manifest.instanceId).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
