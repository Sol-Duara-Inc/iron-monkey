import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildManifest } from '../../src/manifest/builder.js';
import { validateWorkflow } from '../../src/workflow/parser.js';
import { resolveChainTree, flattenChains } from '../../src/workflow/chain-tree.js';
import { createRegistry } from '../../src/expressions/loader.js';
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

  it('reports an unknown CDEvent type (§6.2 failure mode)', async () => {
    const badEvent: ResolvedEvent = {
      ...singleEvent,
      type: 'dev.cdevents.unknown.event.9.9.9',
    };
    await expect(buildManifest(meta, [badEvent], config, { noConduit: true })).rejects.toThrow(
      /unknown CDEvent type unknown\.event/,
    );
  });

  it('throws when no schema exists for a resolved version', async () => {
    // approval.* is in the version catalog but ships no bundled payload
    // schema — resolution succeeds, the schema lookup is what fails.
    const badEvent: ResolvedEvent = {
      ...singleEvent,
      type: 'dev.cdevents.approval.created',
    };
    await expect(buildManifest(meta, [badEvent], config, { noConduit: true })).rejects.toThrow(
      /No schema found for event type 'dev\.cdevents\.approval\.created\.0\.1\.0' \(resolved from 'dev\.cdevents\.approval\.created'\)/,
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

describe('buildManifest — the chain handshake', () => {
  const CONDUIT_CFG: IronMonkeyConfig = {
    buses: { default: { type: 'rabbitmq', url: 'amqp://localhost' } },
    tools: {},
    schemasPath: SCHEMAS_DIR,
    conduit: { url: 'http://conduit.example:8080' },
  };

  /** The answered chain set, in the shape the line actually returns. */
  const chainsResponse = (chains: Record<string, string>, status = 200) => ({
    ok: status < 400,
    status,
    text: async () =>
      JSON.stringify({
        runId: chains.root,
        workflowId: meta.id,
        executionId: 'whatever-the-caller-sent',
        chains,
      }),
  });

  const ROOT = '99999999-aaaa-4bbb-8ccc-dddddddddddd';

  it('acquires every chain in ONE GET and runs on the id the authority minted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(chainsResponse({ root: ROOT })));
    try {
      const manifest = await buildManifest(meta, [singleEvent], CONDUIT_CFG, { noConduit: false });
      expect(manifest.chainId).toBe(ROOT);
      expect(manifest.chainIdSource).toBe('conduit');
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        { method: string },
      ];
      expect(init.method).toBe('GET');
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe('http://conduit.example:8080/api/v1/chains');
      expect(parsed.searchParams.get('workflow')).toBe(meta.id);
      // The handshake is REFUSED without a tool, and the run is keyed
      // `tool + ":" + execution` — so both must actually be on the wire.
      expect(parsed.searchParams.get('tool')).toBe('iron-monkey');
      expect(parsed.searchParams.get('execution')).toBe(manifest.runId);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('asks under the configured tool identity when one is named', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(chainsResponse({ root: ROOT })));
    try {
      await buildManifest(
        meta,
        [singleEvent],
        { ...CONDUIT_CFG, conduit: { url: 'http://conduit.example:8080', tool: 'jenkins-prod' } },
        { noConduit: false },
      );
      const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
      expect(new URL(url).searchParams.get('tool')).toBe('jenkins-prod');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails the run BEFORE emitting when the two derivations name different chains', async () => {
    // The daemon names a chain this producer never derived: two documents
    // under one workflow id. Emitting anyway would put every event of the
    // unmatched chain on an id the authority refuses.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(chainsResponse({ root: ROOT, 'p6.s0': 'other-id' })),
    );
    try {
      await expect(
        buildManifest(meta, [singleEvent], CONDUIT_CFG, { noConduit: false }),
      ).rejects.toThrow(/handshake mismatch — two documents under one workflow id/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('names both derivations in the mismatch, so the divergence is diagnosable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(chainsResponse({ root: ROOT, 'p6.s0': 'other-id' })),
    );
    try {
      await buildManifest(meta, [singleEvent], CONDUIT_CFG, { noConduit: false });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('producer derived: root');
      expect((err as Error).message).toContain('daemon answered:  p6.s0, root');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses to proceed when the daemon answers unusably', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'not json' }));
    try {
      await expect(
        buildManifest(meta, [singleEvent], CONDUIT_CFG, { noConduit: false }),
      ).rejects.toThrow(/unusable body/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('surfaces a refusal rather than minting locally behind it', async () => {
    // A daemon that is ANSWERING must never be routed around: the fallback id
    // would be refused at the door on every single event.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'expected ?workflow=&tool=' }),
      }),
    );
    try {
      await expect(
        buildManifest(meta, [singleEvent], CONDUIT_CFG, { noConduit: false }),
      ).rejects.toThrow(/HTTP 400/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('lets Conduit OUTRANK a chainId the bus supplied', async () => {
    // A bus-supplied id is only usable if that bus got it from the authority,
    // which the producer cannot verify. Letting it win silently means the
    // handshake is never made and every event is refused.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(chainsResponse({ root: ROOT })));
    try {
      const manifest = await buildManifest(meta, [singleEvent], CONDUIT_CFG, {
        noConduit: false,
        chainId: 'bus-minted-id',
        chainIdSource: 'bus',
      });
      expect(manifest.chainId).toBe(ROOT);
      expect(manifest.chainIdSource).toBe('conduit');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still honours a bus-supplied chainId when no Conduit is configured', async () => {
    const noConduitCfg: IronMonkeyConfig = { ...CONDUIT_CFG, conduit: undefined };
    const manifest = await buildManifest(meta, [singleEvent], noConduitCfg, {
      noConduit: false,
      chainId: 'bus-minted-id',
      chainIdSource: 'bus',
    });
    expect(manifest.chainId).toBe('bus-minted-id');
    expect(manifest.chainIdSource).toBe('bus');
  });

  it('falls back offline when no daemon answers the handshake', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')));
    try {
      const manifest = await buildManifest(meta, [singleEvent], CONDUIT_CFG, { noConduit: false });
      expect(manifest.chainIdSource).toBe('fallback');
      expect(manifest.chainId).toMatch(/^urn:sol-duara:fallback:/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('buildManifest — §6.1 wire types', () => {
  it('stamps the RESOLVED type on the wire while the derivation keeps the authored form', async () => {
    const chain = resolveChainTree(
      {
        workflow: {
          id: 'wf-versionless',
          name: 'wf-versionless',
          defaults: { tool: 't', source: 'https://t.example/' },
          produces: [
            { event: 'dev.cdevents.pipelinerun.started' },
            { event: 'dev.cdevents.build.started:^0.3.0' },
          ],
        },
      } as never,
      createRegistry([]),
    );
    const manifest = await buildManifest(
      { id: 'wf-versionless', name: 'wf-versionless' },
      chain,
      config,
      { noConduit: true },
    );

    // Wire: concrete resolved versions, in both the event row and the payload.
    expect(manifest.events.map((e) => e.type)).toEqual([
      'dev.cdevents.pipelinerun.started.0.3.0',
      'dev.cdevents.build.started.0.3.0',
    ]);
    expect(manifest.events.map((e) => e.payload.context.type)).toEqual([
      'dev.cdevents.pipelinerun.started.0.3.0',
      'dev.cdevents.build.started.0.3.0',
    ]);
    // Derivation/register currency: the authored strings, untouched.
    expect(flattenChains(chain)[0].events.map((e) => e.type)).toEqual([
      'dev.cdevents.pipelinerun.started',
      'dev.cdevents.build.started:^0.3.0',
    ]);
  });
});
