import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { loadExpressionRegistry } from '../../src/loaders/expression.loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = path.resolve(__dirname, '../../expressions');

async function makeTmpDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `iron-monkey-expr-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

function minimalBundle(name: string, group = 'sol-duara', author = 'dsanyika'): string {
  return `group: ${group}\nauthor: ${author}\nexpression: ${name}\nproduces:\n  - event: dev.cdevents.build.started.0.5.1\n`;
}

// ── bundled directory ─────────────────────────────────────────────────────────

describe('loadExpressionRegistry — bundled expressions', () => {
  it('loads all bundled expressions without error', () => {
    // Primary staleness sentinel: any unsupported feature in an expression file
    // causes this to throw immediately, pinpointing the offending file.
    expect(() => loadExpressionRegistry(BUNDLED_DIR)).not.toThrow();
  });

  it('loads expressions from all three groups', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const groups = new Set(registry.list().map((b) => b.group));
    expect(groups).toContain('sol-duara');
    expect(groups).toContain('compliance');
    expect(groups).toContain('spin-dev');
  });

  it('resolves sol-duara/dsanyika/build to a 4-event bundle', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('sol-duara/dsanyika/build');
    expect(bundle.expression).toBe('build');
    expect(bundle.group).toBe('sol-duara');
    expect(bundle.author).toBe('dsanyika');
    expect(bundle.produces).toHaveLength(4);
  });

  it('resolves sol-duara/dsanyika/artifact-store to a 2-event bundle', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('sol-duara/dsanyika/artifact-store');
    expect(bundle.expression).toBe('artifact-store');
    expect(bundle.produces).toHaveLength(2);
  });

  it('resolves sol-duara/dsanyika/deploy to a 4-event bundle', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('sol-duara/dsanyika/deploy');
    expect(bundle.expression).toBe('deploy');
    expect(bundle.produces).toHaveLength(4);
  });

  it('resolves using author/expression path form', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('dsanyika/build');
    expect(bundle.expression).toBe('build');
  });

  it('resolves using group/author/expression path form', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('sol-duara/dsanyika/build');
    expect(bundle.expression).toBe('build');
  });

  it('bare "build" is ambiguous', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    expect(() => registry.resolve('build')).toThrow('Ambiguous expression reference');
  });

  it('resolveWithContext disambiguates bare "build" by author', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolveWithContext('build', { group: 'sol-duara', author: 'dsanyika' });
    expect(bundle.author).toBe('dsanyika');
  });

  it('loads composite expressions (expression refs in produces) without error', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    // build-deploy has "expression: build" and "expression: deploy" in its produces
    expect(() => registry.resolve('dsanyika/build-deploy')).not.toThrow();
    // audit-evidence has "expression: ticket-trail" in its produces
    expect(() => registry.resolve('cstump/audit-evidence')).not.toThrow();
  });

  it('loads expressions with detach chains without error', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    expect(() => registry.resolve('dsanyika/canary-deploy')).not.toThrow();
    expect(() => registry.resolve('dsanyika/build-with-async-scan')).not.toThrow();
    expect(() => registry.resolve('dsanyika/deploy-with-notify')).not.toThrow();
  });
});

// ── error cases ───────────────────────────────────────────────────────────────

describe('loadExpressionRegistry — error cases', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTmp(name: string, content: string): Promise<string> {
    const file = path.join(tmpDir, name);
    await writeFile(file, content, 'utf-8');
    return file;
  }

  it('fails with clear error on unresolvable reference', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    expect(() => registry.resolve('nonexistent')).toThrow(
      "No expression bundle found for 'nonexistent'",
    );
  });

  it('fails with clear error on missing required fields in bundle', async () => {
    await writeTmp('bad.yaml', `expression:\n  name: bad\n  version: 1.0.0\n`);
    expect(() => loadExpressionRegistry(tmpDir)).toThrow('schema validation failed');
  });

  it('fails with clear error on malformed YAML bundle', async () => {
    await writeTmp('broken.yaml', `group: [invalid: yaml: {\n`);
    expect(() => loadExpressionRegistry(tmpDir)).toThrow('Failed to parse expression bundle YAML');
  });

  it('fails when bundle has noun.verb collision without explicit ids', async () => {
    await writeTmp(
      'collision.yaml',
      `group: sol-duara\nauthor: dsanyika\nexpression: collision\nproduces:\n  - event: dev.cdevents.build.started.0.5.1\n  - event: dev.cdevents.build.started.0.5.1\n`,
    );
    expect(() => loadExpressionRegistry(tmpDir)).toThrow("must each have an explicit 'id' field");
  });
});

// ── path-style resolution ─────────────────────────────────────────────────────

describe('loadExpressionRegistry — path-style resolution', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTmp(name: string, content: string): Promise<string> {
    const file = path.join(tmpDir, name);
    await writeFile(file, content, 'utf-8');
    return file;
  }

  it('resolves simple name when unambiguous', async () => {
    await writeTmp('myexpr.yaml', minimalBundle('myexpr'));
    const registry = loadExpressionRegistry(tmpDir);
    const bundle = registry.resolve('myexpr');
    expect(bundle.expression).toBe('myexpr');
  });

  it('resolves author/expression path form', async () => {
    await writeTmp('myexpr.yaml', minimalBundle('myexpr'));
    const registry = loadExpressionRegistry(tmpDir);
    const bundle = registry.resolve('dsanyika/myexpr');
    expect(bundle.expression).toBe('myexpr');
  });

  it('resolves group/author/expression fully-qualified form', async () => {
    await writeTmp('myexpr.yaml', minimalBundle('myexpr'));
    const registry = loadExpressionRegistry(tmpDir);
    const bundle = registry.resolve('sol-duara/dsanyika/myexpr');
    expect(bundle.expression).toBe('myexpr');
  });

  it('raises an error when two bundles share the same expression name', async () => {
    await writeTmp(
      'alpha.yaml',
      `group: acme\nauthor: team-alpha\nexpression: shared\nproduces:\n  - event: dev.cdevents.build.started.0.5.1\n`,
    );
    await writeTmp(
      'beta.yaml',
      `group: acme\nauthor: team-beta\nexpression: shared\nproduces:\n  - event: dev.cdevents.build.finished.0.5.1\n`,
    );
    const registry = loadExpressionRegistry(tmpDir);
    expect(() => registry.resolve('shared')).toThrow('Ambiguous expression reference');
  });

  it('resolveWithContext prefers matching author for bare names', async () => {
    await writeTmp('a.yaml', minimalBundle('shared', 'org-a', 'alice'));
    await writeTmp('b.yaml', minimalBundle('shared', 'org-b', 'bob'));
    const registry = loadExpressionRegistry(tmpDir);
    const bundle = registry.resolveWithContext('shared', { group: 'org-a', author: 'alice' });
    expect(bundle.author).toBe('alice');
  });
});
