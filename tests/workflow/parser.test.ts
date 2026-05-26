import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';
import { validateWorkflow, resolveProduces } from '../../src/workflow/parser.js';
import { loadExpressionRegistry } from '../../src/loaders/expression.loader.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPRESSIONS_DIR = path.resolve(__dirname, '../../expressions');
const WORKFLOWS_DIR = path.resolve(__dirname, '../../examples/workflows');

async function writeTmpYaml(content: string): Promise<string> {
  const dir = await mkdir(path.join(os.tmpdir(), 'iron-monkey-test'), { recursive: true }).then(
    () => path.join(os.tmpdir(), 'iron-monkey-test'),
  );
  const file = path.join(dir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  await writeFile(file, content, 'utf-8');
  return file;
}

// Minimal valid workflow — cdrus block is required by the updated CDrus schema.
const minimalWorkflow = `
workflow:
  id: test-wf
  name: test
  cdrus:
    version: 1
  produces:
    - event: dev.cdevents.build.started.0.5.1
      tool: jenkins
      source: https://jenkins.example.com/
`;

describe('validateWorkflow', () => {
  it('parses a valid minimal workflow with produces', async () => {
    const file = await writeTmpYaml(minimalWorkflow);
    const result = await validateWorkflow(file);
    expect(result.workflow.id).toBe('test-wf');
    expect(result.workflow.produces).toHaveLength(1);
    await unlink(file);
  });

  it('parses a workflow with group and author fields', async () => {
    const file = await writeTmpYaml(`
workflow:
  id: test-wf
  group: spin-dev
  author: shipwreck-sa
  name: test
  cdrus:
    version: 1
  produces:
    - event: dev.cdevents.build.started.0.5.1
      tool: jenkins
      source: https://jenkins.example.com/
`);
    const result = await validateWorkflow(file);
    expect(result.workflow.group).toBe('spin-dev');
    expect(result.workflow.author).toBe('shipwreck-sa');
    await unlink(file);
  });

  it('rejects a workflow with a bus: field with a clear error', async () => {
    const file = await writeTmpYaml(`
workflow:
  id: test
  name: test
  cdrus:
    version: 1
  bus: default
  produces:
    - event: dev.cdevents.build.started.0.5.1
`);
    await expect(validateWorkflow(file)).rejects.toThrow("'bus' field is not allowed");
    await unlink(file);
  });

  it('rejects a workflow with a stages: field with a clear error', async () => {
    const file = await writeTmpYaml(`
workflow:
  id: test
  name: test
  cdrus:
    version: 1
  stages:
    - id: build
      type: ci
      tool: jenkins
      events:
        - id: e1
          type: dev.cdevents.build.started.0.1.1
`);
    await expect(validateWorkflow(file)).rejects.toThrow("'stages' field is not allowed");
    await unlink(file);
  });

  it('throws on missing required produces field', async () => {
    const file = await writeTmpYaml(`
workflow:
  id: test
  name: test
  cdrus:
    version: 1
`);
    await expect(validateWorkflow(file)).rejects.toThrow('validation failed');
    await unlink(file);
  });

  it('throws on missing required cdrus field', async () => {
    const file = await writeTmpYaml(`
workflow:
  id: test
  name: test
  produces:
    - event: dev.cdevents.build.started.0.5.1
`);
    await expect(validateWorkflow(file)).rejects.toThrow('validation failed');
    await unlink(file);
  });

  it('throws on missing file', async () => {
    await expect(validateWorkflow('/nonexistent/path.yaml')).rejects.toThrow(
      'Cannot read workflow file',
    );
  });
});

describe('resolveProduces — defaults cascade', () => {
  it('applies workflow.defaults when produces item omits the field', async () => {
    const file = await writeTmpYaml(`
workflow:
  id: test
  name: test
  cdrus:
    version: 1
  defaults:
    tool: default-tool
    source: https://default.example.com/
    timeout_ms: 9999
    min_wait_ms: 42
  produces:
    - event: dev.cdevents.build.started.0.5.1
`);
    const wf = await validateWorkflow(file);
    const registry = loadExpressionRegistry(EXPRESSIONS_DIR);
    const events = resolveProduces(wf, registry);
    expect(events[0].tool).toBe('default-tool');
    expect(events[0].source).toBe('https://default.example.com/');
    expect(events[0].timeout_ms).toBe(9999);
    expect(events[0].min_wait_ms).toBe(42);
    await unlink(file);
  });

  it('event-level fields override workflow.defaults', async () => {
    const file = await writeTmpYaml(`
workflow:
  id: test
  name: test
  cdrus:
    version: 1
  defaults:
    tool: default-tool
    timeout_ms: 9999
  produces:
    - event: dev.cdevents.build.started.0.5.1
      tool: override-tool
      timeout_ms: 1234
`);
    const wf = await validateWorkflow(file);
    const registry = loadExpressionRegistry(EXPRESSIONS_DIR);
    const events = resolveProduces(wf, registry);
    expect(events[0].tool).toBe('override-tool');
    expect(events[0].timeout_ms).toBe(1234);
    await unlink(file);
  });
});

describe('resolveProduces — expression items', () => {
  it('inlines expression events from the registry (dsanyika/build → 4 events)', async () => {
    const file = await writeTmpYaml(`
workflow:
  id: test
  name: test
  cdrus:
    version: 1
  produces:
    - expression: dsanyika/build
      tool: jenkins
`);
    const wf = await validateWorkflow(file);
    const registry = loadExpressionRegistry(EXPRESSIONS_DIR);
    const events = resolveProduces(wf, registry);
    expect(events.length).toBe(4);
    expect(events[0].type).toBe('dev.cdevents.build.started.0.5.1');
    expect(events[3].type).toBe('dev.cdevents.build.finished.0.5.1');
    expect(events.every((e) => e.origin === 'expression')).toBe(true);
    await unlink(file);
  });

  it('applies overrides to specific events within an expression', async () => {
    const file = await writeTmpYaml(`
workflow:
  id: test
  name: test
  cdrus:
    version: 1
  produces:
    - expression: dsanyika/deploy
      tool: spinnaker
      source: https://spinnaker.example.com/
      overrides:
        service.deployed:
          tool: gke
          source: https://gke.example.com/
`);
    const wf = await validateWorkflow(file);
    const registry = loadExpressionRegistry(EXPRESSIONS_DIR);
    const events = resolveProduces(wf, registry);
    const deployed = events.find((e) => e.type === 'dev.cdevents.service.deployed.0.5.1');
    const started = events.find((e) => e.type === 'dev.cdevents.taskrun.started.0.5.1');
    expect(deployed?.tool).toBe('gke');
    expect(deployed?.source).toBe('https://gke.example.com/');
    expect(started?.tool).toBe('spinnaker');
    await unlink(file);
  });

  it('fails with clear error when expression bundle is not found', async () => {
    const file = await writeTmpYaml(`
workflow:
  id: test
  name: test
  cdrus:
    version: 1
  produces:
    - expression: nonexistent
      tool: jenkins
`);
    const wf = await validateWorkflow(file);
    const registry = loadExpressionRegistry(EXPRESSIONS_DIR);
    expect(() => resolveProduces(wf, registry)).toThrow(
      "No expression bundle found for 'nonexistent'",
    );
    await unlink(file);
  });

  it('derives unique IDs for duplicate event types', async () => {
    const file = await writeTmpYaml(`
workflow:
  id: test
  name: test
  cdrus:
    version: 1
  produces:
    - event: dev.cdevents.pipelinerun.started.0.5.1
      tool: jenkins
    - event: dev.cdevents.pipelinerun.started.0.5.1
      tool: jfrog
    - event: dev.cdevents.pipelinerun.started.0.5.1
      tool: spinnaker
`);
    const wf = await validateWorkflow(file);
    const registry = loadExpressionRegistry(EXPRESSIONS_DIR);
    const events = resolveProduces(wf, registry);
    const ids = events.map((e) => e.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    expect(ids[0]).toBe('pipelinerun-started');
    expect(ids[1]).toBe('pipelinerun-started-1');
    expect(ids[2]).toBe('pipelinerun-started-2');
    await unlink(file);
  });
});

describe('resolveProduces — cross-tool workflow', () => {
  it('allows multiple pipelineRun.started events across tools', async () => {
    const file = await writeTmpYaml(`
workflow:
  id: test
  name: test
  cdrus:
    version: 1
  produces:
    - event: dev.cdevents.pipelinerun.started.0.5.1
      tool: jenkins
    - event: dev.cdevents.pipelinerun.started.0.5.1
      tool: jfrog
    - event: dev.cdevents.pipelinerun.finished.0.5.1
      tool: jfrog
`);
    const wf = await validateWorkflow(file);
    const registry = loadExpressionRegistry(EXPRESSIONS_DIR);
    const events = resolveProduces(wf, registry);
    expect(events).toHaveLength(3);
    expect(events[0].tool).toBe('jenkins');
    expect(events[1].tool).toBe('jfrog');
    await unlink(file);
  });
});

describe('resolveProduces — composite expressions (expression refs in produces)', () => {
  it('expands dsanyika/blue-green-deploy including nested verify events', async () => {
    const file = await writeTmpYaml(`
workflow:
  id: test
  group: sol-duara
  author: dsanyika
  name: test
  cdrus:
    version: 1
  produces:
    - expression: dsanyika/blue-green-deploy
      tool: spinnaker
`);
    const wf = await validateWorkflow(file);
    const registry = loadExpressionRegistry(EXPRESSIONS_DIR);
    const events = resolveProduces(wf, registry);
    // blue-green-deploy: service.deployed + verify(4) + service.published + service.removed = 7
    expect(events.length).toBe(7);
    expect(events[0].type).toBe('dev.cdevents.service.deployed.0.5.1');
    expect(events[events.length - 1].type).toBe('dev.cdevents.service.removed.0.5.1');
  });
});

describe('resolveProduces — group/author disambiguation on real prod workflows', () => {
  it('parses and resolves prod-auth-hotfix-fast-path.yaml without error', async () => {
    const wf = await validateWorkflow(path.join(WORKFLOWS_DIR, 'prod-auth-hotfix-fast-path.yaml'));
    const registry = loadExpressionRegistry(EXPRESSIONS_DIR);
    const events = resolveProduces(wf, registry);
    // pipelinerun.started (1) + spin-dev/shipwreck-sa/build (9) + service-deploy (2) + pipelinerun.finished (1)
    expect(events.length).toBeGreaterThan(5);
    expect(events[0].type).toBe('dev.cdevents.pipelinerun.started.0.5.1');
    expect(events[events.length - 1].type).toBe('dev.cdevents.pipelinerun.finished.0.5.1');
  });

  it('parses and resolves prod-payments-blue-green-cutover.yaml without error', async () => {
    const wf = await validateWorkflow(
      path.join(WORKFLOWS_DIR, 'prod-payments-blue-green-cutover.yaml'),
    );
    const registry = loadExpressionRegistry(EXPRESSIONS_DIR);
    const events = resolveProduces(wf, registry);
    expect(events.length).toBeGreaterThan(5);
    expect(events[0].type).toBe('dev.cdevents.pipelinerun.started.0.5.1');
    expect(events[events.length - 1].type).toBe('dev.cdevents.pipelinerun.finished.0.5.1');
  });

  it('parses and resolves prod-checkout-jenkins-spinnaker-canary.yaml without error', async () => {
    const wf = await validateWorkflow(
      path.join(WORKFLOWS_DIR, 'prod-checkout-jenkins-spinnaker-canary.yaml'),
    );
    const registry = loadExpressionRegistry(EXPRESSIONS_DIR);
    expect(() => resolveProduces(wf, registry)).not.toThrow();
  });

  it('prod-auth workflow disambiguates bare "build" to spin-dev/shipwreck-sa/build', async () => {
    const wf = await validateWorkflow(path.join(WORKFLOWS_DIR, 'prod-auth-hotfix-fast-path.yaml'));
    const registry = loadExpressionRegistry(EXPRESSIONS_DIR);
    const events = resolveProduces(wf, registry);
    // spin-dev/shipwreck-sa/build starts with change.merged (not build.started)
    const first = events.find((e) => e.expressionRef !== undefined);
    expect(first?.type).toBe('dev.cdevents.change.merged.0.5.1');
  });
});
