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

describe('loadExpressionRegistry — bundled expressions', () => {
  it('loads all three bundled expressions', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const list = registry.list();
    const names = list.map((b) => b.name);
    expect(names).toContain('build');
    expect(names).toContain('artifact-store');
    expect(names).toContain('deploy');
  });

  it('resolves build:^0.1.0 to the highest matching version', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('build:^0.1.0');
    expect(bundle.name).toBe('build');
    expect(bundle.version).toBe('0.1.0');
    expect(bundle.produces).toHaveLength(4);
  });

  it('resolves artifact-store:^0.1.0', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('artifact-store:^0.1.0');
    expect(bundle.name).toBe('artifact-store');
    expect(bundle.produces).toHaveLength(2);
  });

  it('resolves deploy:^0.1.0 and includes explicit ids', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('deploy:^0.1.0');
    expect(bundle.name).toBe('deploy');
    expect(bundle.produces).toHaveLength(4);
    expect(bundle.produces[0].min_wait_ms).toStrictEqual(100);
    expect(bundle.produces[3].timeout_ms).toStrictEqual(30000);
  });
});

describe('loadExpressionRegistry — error cases', () => {
  it('fails with clear error on unresolvable reference', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    expect(() => registry.resolve('nonexistent:^1.0.0')).toThrow(
      "No expression bundle found for 'nonexistent:^1.0.0'",
    );
  });

  it('fails with clear error when range does not match any version', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    expect(() => registry.resolve('build:^9.9.9')).toThrow(
      "No expression bundle found for 'build:^9.9.9'",
    );
  });

  it('fails with clear error on missing required fields in bundle', async () => {
    const dir = await makeTmpDir();
    await writeFile(
      path.join(dir, 'bad-1.0.0.yaml'),
      `expression:\n  name: bad\n  version: 1.0.0\n`,
      'utf-8',
    );
    expect(() => loadExpressionRegistry(dir)).toThrow('schema validation failed');
  });

  it('fails with clear error on malformed YAML bundle', async () => {
    const dir = await makeTmpDir();
    await writeFile(
      path.join(dir, 'broken-1.0.0.yaml'),
      `expression: [invalid: yaml: {\n`,
      'utf-8',
    );
    expect(() => loadExpressionRegistry(dir)).toThrow('Failed to parse expression bundle YAML');
  });

  it('fails when bundle has noun.verb collision without explicit ids', async () => {
    const dir = await makeTmpDir();
    await writeFile(
      path.join(dir, 'collision-1.0.0.yaml'),
      `expression:
  name: collision
  version: 1.0.0
  produces:
    - event: dev.cdevents.build.started.0.5.1
    - event: dev.cdevents.build.started.0.5.1
`,
      'utf-8',
    );
    expect(() => loadExpressionRegistry(dir)).toThrow("must each have an explicit 'id' field");
  });
});

describe('loadExpressionRegistry — semver range matching', () => {
  it('exact match resolves correctly', async () => {
    const dir = await makeTmpDir();
    await writeFile(
      path.join(dir, 'myexpr-1.2.3.yaml'),
      `expression:
  name: myexpr
  version: 1.2.3
  produces:
    - event: dev.cdevents.build.started.0.5.1
`,
      'utf-8',
    );
    const registry = loadExpressionRegistry(dir);
    const bundle = registry.resolve('myexpr:1.2.3');
    expect(bundle.version).toBe('1.2.3');
  });

  it('caret range selects highest compatible version', async () => {
    const dir = await makeTmpDir();
    for (const v of ['0.1.0', '0.1.1', '0.2.0']) {
      await writeFile(
        path.join(dir, `expr-${v}.yaml`),
        `expression:
  name: expr
  version: ${v}
  produces:
    - event: dev.cdevents.build.started.0.5.1
`,
        'utf-8',
      );
    }
    const registry = loadExpressionRegistry(dir);
    // ^0.1.0 matches 0.1.x only (minor 1, patch >= 0)
    const bundle = registry.resolve('expr:^0.1.0');
    expect(bundle.version).toBe('0.1.1');
  });
});
