import { describe, it, expect, vi } from 'vitest';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { loadExpressionRegistry } from '../../src/expressions/loader.js';
import { getLogger } from '../../src/logger/index.js';

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
    // This test is the primary staleness sentinel: if any expression file uses
    // a feature the schema does not support, this throws immediately.
    expect(() => loadExpressionRegistry(BUNDLED_DIR)).not.toThrow();
  });

  it('loads expressions from all three groups', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const list = registry.list();
    const groups = new Set(list.map((b) => b.group));
    expect(groups).toContain('sol-duara');
    expect(groups).toContain('compliance');
    expect(groups).toContain('spin-dev');
  });

  it('includes the expected authors for each group', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const list = registry.list();
    const byGroup = (g: string) => list.filter((b) => b.group === g).map((b) => b.author);
    expect(new Set(byGroup('sol-duara'))).toContain('dsanyika');
    expect(new Set(byGroup('compliance'))).toContain('cstump');
    expect(new Set(byGroup('spin-dev'))).toContain('shipwreck-sa');
  });

  it('resolves sol-duara/dsanyika/build correctly', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('sol-duara/dsanyika/build');
    expect(bundle.expression).toBe('build');
    expect(bundle.group).toBe('sol-duara');
    expect(bundle.author).toBe('dsanyika');
    expect(bundle.produces).toHaveLength(4);
  });

  it('resolves sol-duara/dsanyika/artifact-store correctly', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('sol-duara/dsanyika/artifact-store');
    expect(bundle.expression).toBe('artifact-store');
    expect(bundle.produces).toHaveLength(2);
  });

  it('resolves sol-duara/dsanyika/deploy correctly', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('sol-duara/dsanyika/deploy');
    expect(bundle.expression).toBe('deploy');
    expect(bundle.produces).toHaveLength(4);
  });

  it('resolves using author/expression path form', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('dsanyika/build');
    expect(bundle.expression).toBe('build');
    expect(bundle.author).toBe('dsanyika');
  });

  it('resolves using group/author/expression path form', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('sol-duara/dsanyika/build');
    expect(bundle.expression).toBe('build');
  });

  it('bare "build" reference is ambiguous when multiple groups define it', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    expect(() => registry.resolve('build')).toThrow('Ambiguous expression reference');
  });

  it('resolveWithContext disambiguates bare "build" using workflow author', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolveWithContext('build', { group: 'sol-duara', author: 'dsanyika' });
    expect(bundle.group).toBe('sol-duara');
    expect(bundle.author).toBe('dsanyika');
  });

  it('resolveWithContext disambiguates bare "build" for spin-dev/shipwreck-sa', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolveWithContext('build', {
      group: 'spin-dev',
      author: 'shipwreck-sa',
    });
    expect(bundle.group).toBe('spin-dev');
    expect(bundle.author).toBe('shipwreck-sa');
  });

  it('loads composite expressions (expression refs in produces) without error', () => {
    // blue-green-deploy and build-deploy use expression refs in their produces lists
    expect(() => registry_().resolve('dsanyika/blue-green-deploy')).not.toThrow();
    expect(() => registry_().resolve('dsanyika/build-deploy')).not.toThrow();
  });

  it('loads compliance/cstump expressions including those with expression refs', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    // audit-evidence uses "expression: ticket-trail" in produces
    const bundle = registry.resolve('cstump/audit-evidence');
    expect(bundle.group).toBe('compliance');
    expect(bundle.author).toBe('cstump');
    expect(bundle.produces).toHaveLength(2);
  });

  it('loads expressions with detach chains without error', () => {
    // canary-deploy and build-with-async-scan use detach
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    expect(() => registry.resolve('dsanyika/canary-deploy')).not.toThrow();
    expect(() => registry.resolve('dsanyika/build-with-async-scan')).not.toThrow();
  });
});

function registry_() {
  return loadExpressionRegistry(BUNDLED_DIR);
}

// ── error cases ───────────────────────────────────────────────────────────────

describe('loadExpressionRegistry — error cases', () => {
  it('fails with clear error on unresolvable reference', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    expect(() => registry.resolve('nonexistent')).toThrow(
      "No expression bundle found for 'nonexistent'",
    );
  });

  it('skips a schema-invalid bundle file with a warning instead of throwing', async () => {
    const dir = await makeTmpDir();
    await writeFile(
      path.join(dir, 'bad.yaml'),
      `expression:\n  name: bad\n  version: 1.0.0\n`,
      'utf-8',
    );
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    let registry!: ReturnType<typeof loadExpressionRegistry>;
    expect(() => {
      registry = loadExpressionRegistry(dir);
    }).not.toThrow();
    expect(registry.list()).toEqual([]); // the only file was skipped
    expect(warn).toHaveBeenCalled(); // fail-loud in logs
    warn.mockRestore();
  });

  it('skips a malformed-YAML bundle file with a warning instead of throwing', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'broken.yaml'), `group: [invalid: yaml: {\n`, 'utf-8');
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    expect(() => loadExpressionRegistry(dir)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('loads the good bundles even when one file in the directory is invalid', async () => {
    // The resilience guarantee: one stray/malformed file must not break runs
    // that depend only on the good bundles.
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'good.yaml'), minimalBundle('good-one'), 'utf-8');
    await writeFile(path.join(dir, 'bad.yaml'), `expression:\n  name: bad\n`, 'utf-8');

    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    let registry!: ReturnType<typeof loadExpressionRegistry>;
    expect(() => {
      registry = loadExpressionRegistry(dir);
    }).not.toThrow();
    warn.mockRestore();

    // The good bundle is indexed and resolvable; the bad one is absent.
    expect(registry.list().map((b) => b.name)).toEqual(['good-one']);
    expect(registry.resolve('good-one').expression).toBe('good-one');
    expect(() => registry.resolve('bad')).toThrow("No expression bundle found for 'bad'");
  });

  it('accepts duplicate noun.verb events without explicit ids', async () => {
    // Position is identity. Downstream code allocates unique positional ids at
    // expansion time — see resolveProduces in src/workflow/parser.ts.
    const dir = await makeTmpDir();
    await writeFile(
      path.join(dir, 'collision.yaml'),
      `group: sol-duara\nauthor: dsanyika\nexpression: collision\nproduces:\n  - event: dev.cdevents.build.started.0.5.1\n  - event: dev.cdevents.build.started.0.5.1\n`,
      'utf-8',
    );
    expect(() => loadExpressionRegistry(dir)).not.toThrow();
    const registry = loadExpressionRegistry(dir);
    const bundle = registry.resolve('collision');
    expect(bundle.produces).toHaveLength(2);
  });

  it('fails with a clear error for an overly-qualified path reference', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    expect(() => registry.resolve('a/b/c/d')).toThrow('Invalid expression reference');
  });
});

// ── path-style disambiguation ─────────────────────────────────────────────────

describe('loadExpressionRegistry — path-style disambiguation', () => {
  it('resolves by author/expression when two bundles share the same expression name', async () => {
    const dir = await makeTmpDir();
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

    expect(() => registry.resolve('build')).toThrow('Ambiguous expression reference');

    const alpha = registry.resolve('team-alpha/build');
    expect(alpha.produces[0].event).toBe('dev.cdevents.build.started.0.5.1');

    const beta = registry.resolve('team-beta/build');
    expect(beta.produces[0].event).toBe('dev.cdevents.build.finished.0.5.1');
  });

  it('resolves with fully-qualified group/author/expression path', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'myexpr.yaml'), minimalBundle('myexpr'), 'utf-8');
    const registry = loadExpressionRegistry(dir);
    const bundle = registry.resolve('sol-duara/dsanyika/myexpr');
    expect(bundle.expression).toBe('myexpr');
  });

  it('resolveWithContext prefers same author for bare names', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'a.yaml'), minimalBundle('shared', 'org-a', 'alice'), 'utf-8');
    await writeFile(path.join(dir, 'b.yaml'), minimalBundle('shared', 'org-b', 'bob'), 'utf-8');
    const registry = loadExpressionRegistry(dir);

    const bundle = registry.resolveWithContext('shared', { group: 'org-b', author: 'bob' });
    expect(bundle.author).toBe('bob');
  });
});
