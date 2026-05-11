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

  it('resolves deploy:^0.1.0', () => {
    const registry = loadExpressionRegistry(BUNDLED_DIR);
    const bundle = registry.resolve('deploy:^0.1.0');
    expect(bundle.name).toBe('deploy');
    expect(bundle.produces).toHaveLength(4);
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
    await writeTmp('bad-1.0.0.yaml', `expression:\n  name: bad\n  version: 1.0.0\n`);
    expect(() => loadExpressionRegistry(tmpDir)).toThrow('schema validation failed');
  });

  it('fails with clear error on malformed YAML bundle', async () => {
    await writeTmp('broken-1.0.0.yaml', `expression: [invalid: yaml: {\n`);
    expect(() => loadExpressionRegistry(tmpDir)).toThrow('Failed to parse expression bundle YAML');
  });

  it('fails when bundle has noun.verb collision without explicit ids', async () => {
    await writeTmp(
      'collision-1.0.0.yaml',
      `expression:
  name: collision
  version: 1.0.0
  produces:
    - event: dev.cdevents.build.started.0.5.1
    - event: dev.cdevents.build.started.0.5.1
`,
    );
    expect(() => loadExpressionRegistry(tmpDir)).toThrow("must each have an explicit 'id' field");
  });
});

describe('loadExpressionRegistry — semver range matching', () => {
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

  it('exact match resolves correctly', async () => {
    await writeTmp(
      'myexpr-1.2.3.yaml',
      `expression:
  name: myexpr
  version: 1.2.3
  produces:
    - event: dev.cdevents.build.started.0.5.1
`,
    );
    const registry = loadExpressionRegistry(tmpDir);
    const bundle = registry.resolve('myexpr:1.2.3');
    expect(bundle.version).toBe('1.2.3');
  });

  it('caret range selects highest compatible version', async () => {
    for (const v of ['0.1.0', '0.1.1', '0.2.0']) {
      await writeTmp(
        `expr-${v}.yaml`,
        `expression:
  name: expr
  version: ${v}
  produces:
    - event: dev.cdevents.build.started.0.5.1
`,
      );
    }
    const registry = loadExpressionRegistry(tmpDir);
    // ^0.1.0 matches 0.1.x only (minor 1, patch >= 0)
    const bundle = registry.resolve('expr:^0.1.0');
    expect(bundle.version).toBe('0.1.1');
  });
});
