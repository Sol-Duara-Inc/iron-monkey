import { describe, it, expect, vi } from 'vitest';
import { writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadExpressionRegistry } from '../../src/expressions/loader.js';
import { makeTmpDir as sharedTmpDir } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = path.resolve(__dirname, '../../expressions');

const makeTmpDir = () => sharedTmpDir('iron-monkey-hints');

const HEADER = 'group: test-group\nauthor: tester\n';

// ── loader posture: violations skip-with-warning ──────────────────────────────

describe('loadExpressionRegistry — name-hint enforcement', () => {
  it('skips a bundle whose name hint is unsatisfied and records the finding', async () => {
    const dir = await makeTmpDir();
    // 'build' hint requires build.started AND build.finished; only queued given.
    await writeFile(
      path.join(dir, 'bad.yaml'),
      `${HEADER}expression: build\nproduces:\n  - event: dev.cdevents.build.queued.0.3.0\n`,
      'utf-8',
    );
    const registry = loadExpressionRegistry(dir);

    expect(registry.list()).toHaveLength(0);
    const findings = registry.hintFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0].skipped).toBe(true);
    expect(findings[0].identity).toBe('test-group/tester/build');
    expect(findings[0].result.violations[0].hint).toBe('build');
    expect(() => registry.resolve('build')).toThrow(/No expression bundle found/);
  });

  it('loads a bundle whose hint is satisfied by delegation', async () => {
    const dir = await makeTmpDir();
    await writeFile(
      path.join(dir, 'composite.yaml'),
      `${HEADER}expression: build-deploy\nproduces:\n  - expression: build\n  - expression: deploy\n`,
      'utf-8',
    );
    const registry = loadExpressionRegistry(dir);

    expect(registry.list()).toHaveLength(1);
    expect(registry.hintFindings()).toHaveLength(0);
  });

  it('loads a bundle with only a spelling diagnostic and records it as not skipped', async () => {
    const dir = await makeTmpDir();
    await writeFile(
      path.join(dir, 'diag.yaml'),
      `${HEADER}expression: my-test-case-run-job\nproduces:\n  - event: dev.cdevents.change.created.0.3.0\n`,
      'utf-8',
    );
    const registry = loadExpressionRegistry(dir);

    expect(registry.list()).toHaveLength(1);
    const findings = registry.hintFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0].skipped).toBe(false);
    expect(findings[0].result.diagnostics[0].subject).toBe('testcaserun');
  });

  it('keeps loading the rest of the directory around a violating bundle', async () => {
    const dir = await makeTmpDir();
    await writeFile(
      path.join(dir, 'bad.yaml'),
      `${HEADER}expression: nightly-build\nproduces:\n  - event: dev.cdevents.change.created.0.3.0\n`,
      'utf-8',
    );
    await writeFile(
      path.join(dir, 'good.yaml'),
      `${HEADER}expression: change-request\nproduces:\n  - event: dev.cdevents.change.merged.0.3.0\n`,
      'utf-8',
    );
    const registry = loadExpressionRegistry(dir);

    expect(registry.list().map((b) => b.name)).toEqual(['change-request']);
    expect(registry.hintFindings().filter((f) => f.skipped)).toHaveLength(1);
  });
});

// ── bundled expressions stay clean ────────────────────────────────────────────

describe('bundled expressions — name-hint compliance sentinel', () => {
  it('no bundled expression violates its name hints', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const skipped = registry.hintFindings().filter((f) => f.skipped);
    expect(skipped.map((f) => f.identity)).toEqual([]);
  });

  it('known hyphenated-spelling diagnostics are advisory, not blocking', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const diagnosed = registry
      .hintFindings()
      .filter((f) => !f.skipped)
      .map((f) => f.result.name);
    // pipeline-run spells 'pipelinerun'; test-output-publish spells 'testoutput'.
    expect(diagnosed).toContain('pipeline-run');
    expect(diagnosed).toContain('test-output-publish');
    // Both still resolve — diagnostics never affect acceptance.
    expect(() => registry.resolve('example-group/user/pipeline-run')).not.toThrow();
    expect(() => registry.resolve('example-group/user/test-output-publish')).not.toThrow();
  });
});

// ── fail-soft when the keyword table is unavailable ───────────────────────────

describe('loadExpressionRegistry — hint table unavailable', () => {
  it('loads even hint-violating bundles when the table cannot be loaded (fail-soft)', async () => {
    vi.resetModules();
    vi.doMock('../../src/hints/index.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/hints/index.js')>();
      return {
        ...actual,
        loadHintTable: () => {
          throw new Error('simulated: table missing');
        },
      };
    });
    const { loadExpressionRegistry: loadWithBrokenTable } =
      await import('../../src/expressions/loader.js');

    const dir = await makeTmpDir();
    // 'build' hint would normally be violated (only queued) → skip. With the
    // table unavailable, the gate is OFF and the bundle loads.
    await writeFile(
      path.join(dir, 'bad.yaml'),
      `${HEADER}expression: build\nproduces:\n  - event: dev.cdevents.build.queued.0.3.0\n`,
      'utf-8',
    );
    const registry = loadWithBrokenTable(dir);
    expect(registry.list().map((b) => b.name)).toEqual(['build']);
    expect(registry.hintFindings()).toEqual([]);
    vi.doUnmock('../../src/hints/index.js');
    vi.resetModules();
  });
});
