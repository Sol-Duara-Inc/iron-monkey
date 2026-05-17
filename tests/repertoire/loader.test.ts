import { describe, it, expect } from 'vitest';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import { loadRepertoire, buildPitchOptions } from '../../src/repertoire/loader.js';
import type { RepertoireFile } from '../../src/repertoire/types.js';

async function makeTmpDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `iron-monkey-repertoire-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeRepertoire(dir: string, content: string): Promise<string> {
  const file = path.join(dir, 'repertoire.yaml');
  await writeFile(file, content, 'utf-8');
  return file;
}

// ── loadRepertoire ────────────────────────────────────────────────────────────

describe('loadRepertoire', () => {
  it('parses a minimal valid repertoire', async () => {
    const dir = await makeTmpDir();
    const file = await writeRepertoire(
      dir,
      `
pitches:
  - workflow: happy-path.yaml
`,
    );
    const repertoire = await loadRepertoire(file);
    expect(repertoire.pitches).toHaveLength(1);
    expect(repertoire.pitches[0].workflow).toBe('happy-path.yaml');
  });

  it('parses shared defaults and multiple pitches', async () => {
    const dir = await makeTmpDir();
    const file = await writeRepertoire(
      dir,
      `
shared:
  bus: rabbitmq-prod
  interval: 1000
pitches:
  - workflow: happy-path.yaml
    interval: 500
  - workflow: sample.yaml
    seed: 42
`,
    );
    const repertoire = await loadRepertoire(file);
    expect(repertoire.shared?.bus).toBe('rabbitmq-prod');
    expect(repertoire.shared?.interval).toBe(1000);
    expect(repertoire.pitches).toHaveLength(2);
    expect(repertoire.pitches[0].interval).toBe(500);
    expect(repertoire.pitches[1].seed).toBe(42);
  });

  it('throws when the file does not exist', async () => {
    await expect(loadRepertoire('/no/such/file.yaml')).rejects.toThrow(
      'Cannot read repertoire file',
    );
  });

  it('throws on invalid YAML', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'bad.yaml');
    await writeFile(file, 'pitches: [unclosed', 'utf-8');
    await expect(loadRepertoire(file)).rejects.toThrow('Invalid YAML');
  });

  it('throws when pitches array is missing', async () => {
    const dir = await makeTmpDir();
    const file = await writeRepertoire(dir, 'shared:\n  interval: 500\n');
    await expect(loadRepertoire(file)).rejects.toThrow("non-empty 'pitches' array");
  });

  it('throws when pitches array is empty', async () => {
    const dir = await makeTmpDir();
    const file = await writeRepertoire(dir, 'pitches: []\n');
    await expect(loadRepertoire(file)).rejects.toThrow("non-empty 'pitches' array");
  });

  it('throws when the document root is not an object', async () => {
    const dir = await makeTmpDir();
    const file = await writeRepertoire(dir, '- just a list\n');
    await expect(loadRepertoire(file)).rejects.toThrow('must be a YAML object');
  });
});

// ── buildPitchOptions ─────────────────────────────────────────────────────────

describe('buildPitchOptions', () => {
  const base: RepertoireFile = {
    pitches: [
      { workflow: 'a.yaml' },
      { workflow: 'b.yaml', interval: 200 },
      { workflow: 'c.yaml', bus: 'local', seed: 7 },
    ],
  };

  it('returns one entry per pitch in order', () => {
    const result = buildPitchOptions(base);
    expect(result.map((r) => r.workflowPath)).toEqual(['a.yaml', 'b.yaml', 'c.yaml']);
  });

  it('applies shared defaults to all pitches', () => {
    const repertoire: RepertoireFile = {
      shared: { bus: 'shared-bus', interval: 1000 },
      pitches: [{ workflow: 'a.yaml' }, { workflow: 'b.yaml' }],
    };
    const result = buildPitchOptions(repertoire);
    expect(result[0].options.bus).toBe('shared-bus');
    expect(result[0].options.interval).toBe(1000);
    expect(result[1].options.bus).toBe('shared-bus');
  });

  it('pitch-level values override shared defaults', () => {
    const repertoire: RepertoireFile = {
      shared: { interval: 1000, bus: 'shared-bus' },
      pitches: [{ workflow: 'a.yaml', interval: 50, bus: 'override-bus' }],
    };
    const [result] = buildPitchOptions(repertoire);
    expect(result.options.interval).toBe(50);
    expect(result.options.bus).toBe('override-bus');
  });

  it('CLI overrides act as base layer beneath shared', () => {
    const repertoire: RepertoireFile = {
      pitches: [{ workflow: 'a.yaml' }],
    };
    const [result] = buildPitchOptions(repertoire, { logLevel: 'debug', config: 'im.yaml' });
    expect(result.options.logLevel).toBe('debug');
    expect(result.options.config).toBe('im.yaml');
  });

  it('shared does not clobber CLI overrides when pitch has no override', () => {
    const repertoire: RepertoireFile = {
      shared: { bus: 'shared-bus' },
      pitches: [{ workflow: 'a.yaml' }],
    };
    const [result] = buildPitchOptions(repertoire, { config: 'im.yaml' });
    expect(result.options.bus).toBe('shared-bus');
    expect(result.options.config).toBe('im.yaml');
  });

  it('maps manifest_out to manifestOut in RunOptions', () => {
    const repertoire: RepertoireFile = {
      pitches: [{ workflow: 'a.yaml', manifest_out: '/tmp/manifest.json' }],
    };
    const [result] = buildPitchOptions(repertoire);
    expect(result.options.manifestOut).toBe('/tmp/manifest.json');
  });

  it('handles a repertoire with no shared block', () => {
    const result = buildPitchOptions(base);
    expect(result[0].options.bus).toBeUndefined();
    expect(result[0].options.interval).toBeUndefined();
  });

  it('passes inject array through to RunOptions', () => {
    const repertoire: RepertoireFile = {
      pitches: [
        { workflow: 'a.yaml', inject: ['missing:build-started', 'late:deploy-finished:2000'] },
      ],
    };
    const [result] = buildPitchOptions(repertoire);
    expect(result.options.inject).toEqual(['missing:build-started', 'late:deploy-finished:2000']);
  });
});
