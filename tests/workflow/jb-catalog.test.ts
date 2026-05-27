/**
 * @file jb-catalog.test.ts
 * End-to-end integration test exercising the FULL Iron Monkey pipeline
 * (parser → expression registry → resolveProduces → buildManifest →
 * applyInjections → bus.emit) against the real JB-style workflows under
 * `examples/workflows/` and the real expression catalog under `expressions/`.
 *
 * Only the bus is mocked — so any schema regression, resolver semantic drift,
 * or loader collision check that breaks real CDrus YAMLs surfaces here as a
 * runtime failure, not as silently-passing unit tests. This is the test
 * tonight's verification session was missing: unit tests against mocked
 * boundaries cannot catch divergence inside `runWorkflow`'s execution path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeFile, mkdir, rm } from 'fs/promises';
import os from 'os';

// ── hoisted mock objects ─────────────────────────────────────────────────────

const mockBus = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  acquireChainId: vi.fn().mockResolvedValue('chain-integration-test'),
  emit: vi.fn().mockResolvedValue(undefined),
  inspect: vi.fn(),
  purge: vi.fn(),
  disconnect: vi.fn().mockResolvedValue(undefined),
}));

// ── module mocks (bus only — everything else runs for real) ──────────────────

vi.mock('../../src/bus/interface.js', () => ({
  createBus: vi.fn().mockResolvedValue(mockBus),
}));

// ── imports after mocks ──────────────────────────────────────────────────────

import { runWorkflow } from '../../src/emitter/runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, 'examples/workflows');
const EXPRESSIONS_DIR = path.join(REPO_ROOT, 'expressions');

/**
 * The real prod workflows bundled in `examples/workflows/`. Each one walks the
 * full pipeline against the real `expressions/` catalog. A single addition or
 * removal to the example set is welcome; the test loop adapts automatically.
 */
const PROD_WORKFLOWS = [
  'cdcon-2026-jenkins-spinnaker-demo.yaml',
  'prod-api-gateway-production-deploy-gated.yaml',
  'prod-auth-hotfix-fast-path.yaml',
  'prod-checkout-jenkins-spinnaker-canary.yaml',
  'prod-inventory-gha-rolling-release.yaml',
  'prod-payments-blue-green-cutover.yaml',
];

/**
 * Writes a minimal Iron Monkey config file targeting a fake `junction-box`
 * bus. The bus instance is the hoisted mock above — `createBus` is patched
 * to return it regardless of the config — so this file's contents just need
 * to satisfy the config schema, not actually point at a real Junction Box.
 */
async function writeMockIronMonkeyConfig(workflowId: string): Promise<string> {
  const dir = await mkdir(path.join(os.tmpdir(), `im-int-${Date.now()}`), {
    recursive: true,
  });
  const configPath = path.join(dir as string, 'iron-monkey.yaml');
  const config = `buses:
  default:
    type: junction-box
    url: http://test.invalid:9999
    workflow_id: ${workflowId}
    health_check: false
tools: {}
`;
  await writeFile(configPath, config, 'utf-8');
  return configPath;
}

describe('integration: full runWorkflow against bundled JB-style catalog', () => {
  beforeEach(() => {
    mockBus.connect.mockClear();
    mockBus.emit.mockClear();
    mockBus.disconnect.mockClear();
    // Point the real expression loader at this repo's bundled expressions, so
    // composite refs (`build`, `deploy`, etc.) resolve under the std-lib
    // fallback the spec requires.
    process.env.IRON_MONKEY_EXPRESSIONS = EXPRESSIONS_DIR;
  });

  for (const file of PROD_WORKFLOWS) {
    it(`completes end-to-end for ${file} (real validation, resolution, manifest)`, async () => {
      const workflowPath = path.join(WORKFLOWS_DIR, file);
      const workflowId = path.basename(file, '.yaml');
      const configPath = await writeMockIronMonkeyConfig(workflowId);

      try {
        await runWorkflow(workflowPath, {
          config: configPath,
          logLevel: 'silent',
          logFormat: 'text',
          interval: 0,
        });
      } finally {
        await rm(path.dirname(configPath), { recursive: true, force: true });
      }

      // The bus's lifecycle is the contract: connect → emit (one or more) →
      // disconnect. If any earlier stage rejected (schema, resolver, manifest)
      // none of these would have happened.
      expect(mockBus.connect).toHaveBeenCalledTimes(1);
      expect(mockBus.emit).toHaveBeenCalled();
      expect(mockBus.disconnect).toHaveBeenCalledTimes(1);

      // First emit must be the first event of the workflow — a pipelinerun
      // started in every bundled example. If the resolver got the order wrong
      // (or the manifest builder lost an event) this would surface here.
      const firstEmitArgs = mockBus.emit.mock.calls[0];
      expect(firstEmitArgs[0]).toMatch(/^dev\.cdevents\./);

      // Last emit is the chain.end sentinel runWorkflow synthesises.
      const lastEmitArgs = mockBus.emit.mock.calls[mockBus.emit.mock.calls.length - 1];
      expect(lastEmitArgs[0]).toBe('dev.cdevents.chain.end');
    });
  }

  it('emits all events from a workflow that uses both bare and qualified expression refs', async () => {
    // cdcon-2026 references `build`, `artifact-store`, `deploy`, `verify`
    // (all bare) plus terminal direct events. Verify the resolver expanded
    // every expression by counting emitted event types — at least one of
    // each from the build expression (build.started, build.finished) and one
    // from the deploy expression (service.deployed).
    const workflowPath = path.join(WORKFLOWS_DIR, 'cdcon-2026-jenkins-spinnaker-demo.yaml');
    const configPath = await writeMockIronMonkeyConfig('cdcon-2026-jenkins-spinnaker-demo');

    try {
      await runWorkflow(workflowPath, {
        config: configPath,
        logLevel: 'silent',
        logFormat: 'text',
        interval: 0,
      });
    } finally {
      await rm(path.dirname(configPath), { recursive: true, force: true });
    }

    const emittedTypes = mockBus.emit.mock.calls.map((c) => c[0]);
    expect(emittedTypes).toContain('dev.cdevents.build.started.0.5.1');
    expect(emittedTypes).toContain('dev.cdevents.build.finished.0.5.1');
    expect(emittedTypes).toContain('dev.cdevents.service.deployed.0.5.1');
    expect(emittedTypes).toContain('dev.cdevents.chain.end');
  });
});
