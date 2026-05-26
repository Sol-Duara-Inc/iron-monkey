import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildManifest } from '../../src/manifest/builder.js';
import { validateWorkflow, resolveProduces } from '../../src/workflow/parser.js';
import { loadExpressionRegistry } from '../../src/loaders/expression.loader.js';
import type { ResolvedEvent } from '../../src/workflow/parser.js';
import type { IronMonkeyConfig } from '../../src/config/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(__dirname, '../../schemas/cdevents');
const EXPRESSIONS_DIR = path.resolve(__dirname, '../../expressions');
const WORKFLOWS_DIR = path.resolve(__dirname, '../../examples/workflows');

const singleEvent: ResolvedEvent = {
  id: 'build-started',
  type: 'dev.cdevents.build.started.0.5.1',
  tool: 'jenkins',
  source: '',
  pipeline: 'my-pipeline',
  timeout_ms: 1000,
  min_wait_ms: 100,
  subject: { id: 'build-started' },
  origin: 'event',
};

const twoEvents: ResolvedEvent[] = [
  { ...singleEvent, id: 'build-started', type: 'dev.cdevents.build.started.0.5.1' },
  {
    id: 'build-finished',
    type: 'dev.cdevents.build.finished.0.5.1',
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

  it('emits specversion 0.5.1 in every event context', async () => {
    const manifest = await buildManifest(meta, [singleEvent], config, { noConduit: true });
    expect(manifest.events[0].payload.context.specversion).toBe('0.5.1');
  });

  it('emits links as a plain array (not a wrapper object)', async () => {
    const manifest = await buildManifest(meta, twoEvents, config, { noConduit: true });
    const links = manifest.events[1].payload.context.links;
    expect(Array.isArray(links)).toBe(true);
    expect((links as unknown[])[0]).toMatchObject({ type: 'PATH' });
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
});

describe('buildManifest — real workflow end-to-end', () => {
  it('builds a schema-valid manifest from prod-auth-hotfix-fast-path.yaml', async () => {
    const wf = await validateWorkflow(path.join(WORKFLOWS_DIR, 'prod-auth-hotfix-fast-path.yaml'));
    const registry = loadExpressionRegistry(EXPRESSIONS_DIR);
    const events = resolveProduces(wf, registry);

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
      events,
      cfg,
      { noConduit: true },
    );

    expect(manifest.workflowId).toBe('prod-auth-hotfix-fast-path');
    expect(manifest.events.length).toBeGreaterThan(5);
    expect(manifest.events[0].payload.context.specversion).toBe('0.5.1');
    expect(manifest.events[manifest.events.length - 1].isLast).toBe(true);
    // Every event must have a valid payload type matching the CDEvents format
    for (const e of manifest.events) {
      expect(e.payload.context.type).toMatch(/^dev\.cdevents\./);
    }
  });
});
