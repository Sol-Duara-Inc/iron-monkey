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

/** Minimal valid expression bundle in the new CDrus flat format. */
function minimalBundle(name: string): string {
  return `group: sol-duara\nauthor: iron-monkey\nexpression: ${name}\nproduces:\n  - event: dev.cdevents.build.started.0.5.1\n`;
}

describe('loadExpressionRegistry — bundled expressions', () => {
  it('loads all three bundled expressions', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const list = registry.list();
    const names = list.map((b) => b.name);
    expect(names).toContain('build');
    expect(names).toContain('artifact-store');
    expect(names).toContain('deploy');
  });

  it('resolves "build" to the build expression bundle', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('build');
    expect(bundle.expression).toBe('build');
    expect(bundle.produces).toHaveLength(4);
  });

  it('resolves "artifact-store"', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('artifact-store');
    expect(bundle.expression).toBe('artifact-store');
    expect(bundle.produces).toHaveLength(2);
  });

  it('resolves "deploy" and includes timing extensions', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('deploy');
    expect(bundle.expression).toBe('deploy');
    expect(bundle.produces).toHaveLength(4);
    expect(bundle.produces[0].min_wait_ms).toStrictEqual(100);
    expect(bundle.produces[3].timeout_ms).toStrictEqual(30000);
  });
});

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
    // old format triggers schema validation failure
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
      `group: sol-duara\nauthor: iron-monkey\nexpression: collision\nproduces:\n  - event: dev.cdevents.build.started.0.5.1\n  - event: dev.cdevents.build.started.0.5.1\n`,
    );
    expect(() => loadExpressionRegistry(tmpDir)).toThrow("must each have an explicit 'id' field");
  });
});

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
    const bundle = registry.resolve('iron-monkey/myexpr');
    expect(bundle.expression).toBe('myexpr');
  });

  it('resolves group/author/expression fully-qualified form', async () => {
    await writeTmp('myexpr.yaml', minimalBundle('myexpr'));
    const registry = loadExpressionRegistry(tmpDir);
    const bundle = registry.resolve('sol-duara/iron-monkey/myexpr');
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
});
