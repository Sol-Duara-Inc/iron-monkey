import { describe, it, expect } from 'vitest';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { loadExpressionRegistry } from '../../src/expressions/loader.js';

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

// ── helpers ───────────────────────────────────────────────────────────────────

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

  it('list() includes group and author for each bundle', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const list = registry.list();
    for (const entry of list) {
      expect(entry.group).toBe('sol-duara');
      expect(entry.author).toBe('iron-monkey');
      expect(typeof entry.name).toBe('string');
    }
  });

  it('resolves "build" to the build expression bundle', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('build');
    expect(bundle.expression).toBe('build');
    expect(bundle.group).toBe('sol-duara');
    expect(bundle.author).toBe('iron-monkey');
    expect(bundle.produces).toHaveLength(4);
  });

  it('resolves "artifact-store" to the artifact-store bundle', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('artifact-store');
    expect(bundle.expression).toBe('artifact-store');
    expect(bundle.produces).toHaveLength(2);
  });

  it('resolves "deploy" and preserves timing extensions', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('deploy');
    expect(bundle.expression).toBe('deploy');
    expect(bundle.produces).toHaveLength(4);
    expect(bundle.produces[0].min_wait_ms).toStrictEqual(100);
    expect(bundle.produces[3].timeout_ms).toStrictEqual(30000);
  });

  it('resolves using author/expression path form', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('iron-monkey/build');
    expect(bundle.expression).toBe('build');
  });

  it('resolves using group/author/expression path form', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('sol-duara/iron-monkey/build');
    expect(bundle.expression).toBe('build');
  });
});

describe('loadExpressionRegistry — error cases', () => {
  it('fails with clear error on unresolvable reference', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    expect(() => registry.resolve('nonexistent')).toThrow(
      "No expression bundle found for 'nonexistent'",
    );
  });

  it('fails with clear error on missing required fields in bundle', async () => {
    const dir = await makeTmpDir();
    await writeFile(
      path.join(dir, 'bad.yaml'),
      // old format: missing group/author/expression at top level
      `expression:\n  name: bad\n  version: 1.0.0\n`,
      'utf-8',
    );
    expect(() => loadExpressionRegistry(dir)).toThrow('schema validation failed');
  });

  it('fails with clear error on malformed YAML bundle', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'broken.yaml'), `group: [invalid: yaml: {\n`, 'utf-8');
    expect(() => loadExpressionRegistry(dir)).toThrow('Failed to parse expression bundle YAML');
  });

  it('fails when bundle has noun.verb collision without explicit ids', async () => {
    const dir = await makeTmpDir();
    await writeFile(
      path.join(dir, 'collision.yaml'),
      `group: sol-duara\nauthor: iron-monkey\nexpression: collision\nproduces:\n  - event: dev.cdevents.build.started.0.5.1\n  - event: dev.cdevents.build.started.0.5.1\n`,
      'utf-8',
    );
    expect(() => loadExpressionRegistry(dir)).toThrow("must each have an explicit 'id' field");
  });

  it('fails with a clear error for an overly-qualified path reference', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    expect(() => registry.resolve('a/b/c/d')).toThrow('Invalid expression reference');
  });
});

describe('loadExpressionRegistry — path-style disambiguation', () => {
  it('resolves by author/expression when two bundles share the same expression name', async () => {
    const dir = await makeTmpDir();
    // Two bundles with the same expression name but different authors
    await writeFile(
      path.join(dir, 'alpha.yaml'),
      `group: acme\nauthor: team-alpha\nexpression: build\nproduces:\n  - event: dev.cdevents.build.started.0.5.1\n`,
      'utf-8',
    );
    await writeFile(
      path.join(dir, 'beta.yaml'),
      `group: acme\nauthor: team-beta\nexpression: build\nproduces:\n  - event: dev.cdevents.build.finished.0.5.1\n`,
      'utf-8',
    );

    const registry = loadExpressionRegistry(dir);

    // Simple name is ambiguous
    expect(() => registry.resolve('build')).toThrow('Ambiguous expression reference');

    // Qualified by author resolves unambiguously
    const alpha = registry.resolve('team-alpha/build');
    expect(alpha.produces[0].event).toBe('dev.cdevents.build.started.0.5.1');

    const beta = registry.resolve('team-beta/build');
    expect(beta.produces[0].event).toBe('dev.cdevents.build.finished.0.5.1');
  });

  it('resolves with fully-qualified group/author/expression path', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'myexpr.yaml'), minimalBundle('myexpr'), 'utf-8');
    const registry = loadExpressionRegistry(dir);
    const bundle = registry.resolve('sol-duara/iron-monkey/myexpr');
    expect(bundle.expression).toBe('myexpr');
  });
});
