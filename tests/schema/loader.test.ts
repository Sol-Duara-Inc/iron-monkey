import { describe, it, expect } from 'vitest';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { loadSchemasFromDir, getDefaultSchemasDir } from '../../src/schema/loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = path.resolve(__dirname, '../../schemas/cdevents');

async function makeTmpDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `iron-monkey-schema-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('loadSchemasFromDir', () => {
  it('loads all bundled schemas', async () => {
    const schemas = await loadSchemasFromDir(BUNDLED_DIR);
    expect(schemas.size).toBeGreaterThan(40);
    expect(schemas.has('dev.cdevents.pipelinerun.started.0.3.0')).toBe(true);
  });

  it('returns an empty map for a non-existent directory', async () => {
    const schemas = await loadSchemasFromDir('/non-existent-dir');
    expect(schemas.size).toBe(0);
  });

  it('skips non-json files', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'schema.txt'), 'not json');
    const schemas = await loadSchemasFromDir(dir);
    expect(schemas.size).toBe(0);
  });

  it('skips malformed json files', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'schema.json'), 'not json');
    const schemas = await loadSchemasFromDir(dir);
    expect(schemas.size).toBe(0);
  });

  it('skips schemas without a recognisable type string', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'schema.json'), JSON.stringify({ properties: {} }));
    const schemas = await loadSchemasFromDir(dir);
    expect(schemas.size).toBe(0);
  });

  it('extracts the type string and maps it to the schema', async () => {
    const dir = await makeTmpDir();
    const schema = {
      properties: {
        context: {
          properties: {
            type: { enum: ['dev.cdevents.test.0.1.0'] },
          },
        },
      },
    };
    await writeFile(path.join(dir, 'schema.json'), JSON.stringify(schema));
    const schemas = await loadSchemasFromDir(dir);
    expect(schemas.size).toBe(1);
    expect(schemas.has('dev.cdevents.test.0.1.0')).toBe(true);
    expect(schemas.get('dev.cdevents.test.0.1.0')).toEqual(schema);
  });
});

describe('getDefaultSchemasDir', () => {
  it('returns the bundled cdevents schema directory', async () => {
    const dir = await getDefaultSchemasDir();
    expect(dir).toBe(BUNDLED_DIR);
  });
});
