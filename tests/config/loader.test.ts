import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';
import { loadConfig, resolveBusName } from '../../src/config/loader.js';
import type { IronMonkeyConfig } from '../../src/config/types.js';

// ── helpers ───────────────────────────────────────────────────────────────────

async function writeTmp(name: string, content: string): Promise<string> {
  const dir = path.join(os.tmpdir(), 'iron-monkey-cfg-test');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, content, 'utf-8');
  return file;
}

const emptyOptions = { cliOverrides: {} };

// ── resolveBusName ────────────────────────────────────────────────────────────

describe('resolveBusName', () => {
  const multiConfig: IronMonkeyConfig = {
    buses: {
      staging: { type: 'rabbitmq', url: 'amqp://staging' },
      prod: { type: 'rabbitmq', url: 'amqp://prod' },
    },
    tools: {},
  };

  const singleConfig: IronMonkeyConfig = {
    buses: { only: { type: 'rabbitmq', url: 'amqp://only' } },
    tools: {},
  };

  const defaultConfig: IronMonkeyConfig = {
    buses: { default: { type: 'rabbitmq', url: 'amqp://default' } },
    tools: {},
  };

  beforeEach(() => {
    delete process.env.IRON_MONKEY_BUS_NAME;
  });

  afterEach(() => {
    delete process.env.IRON_MONKEY_BUS_NAME;
  });

  it('returns the explicit busName argument when provided', () => {
    expect(resolveBusName(multiConfig, 'staging')).toBe('staging');
  });

  it('falls back to IRON_MONKEY_BUS_NAME env var', () => {
    process.env.IRON_MONKEY_BUS_NAME = 'prod';
    expect(resolveBusName(multiConfig)).toBe('prod');
  });

  it('falls back to "default" when a default bus exists in config', () => {
    expect(resolveBusName(defaultConfig)).toBe('default');
  });

  it('returns the only bus name when exactly one bus is configured', () => {
    expect(resolveBusName(singleConfig)).toBe('only');
  });

  it('throws when multiple buses are configured and none is specified', () => {
    expect(() => resolveBusName(multiConfig)).toThrow('Multiple buses configured');
  });

  it('throws when no buses are configured', () => {
    expect(() => resolveBusName({ buses: {}, tools: {} })).toThrow('No bus configured');
  });
});

// ── loadConfig — file loading ─────────────────────────────────────────────────

describe('loadConfig — YAML file', () => {
  it('loads a valid YAML config file', async () => {
    const file = await writeTmp(
      'valid.yaml',
      `
buses:
  default:
    type: rabbitmq
    url: amqp://localhost:5672
tools:
  jenkins:
    source: https://jenkins.example.com/
`,
    );
    const config = await loadConfig({ configPath: file, cliOverrides: {} });
    expect(config.buses['default']).toMatchObject({ type: 'rabbitmq' });
    expect(config.tools['jenkins']).toMatchObject({ source: 'https://jenkins.example.com/' });
    await unlink(file);
  });

  it('loads a valid JSON config file', async () => {
    const file = await writeTmp(
      'valid.json',
      JSON.stringify({
        buses: { default: { type: 'rabbitmq', url: 'amqp://localhost' } },
        tools: {},
      }),
    );
    const config = await loadConfig({ configPath: file, cliOverrides: {} });
    expect(config.buses['default']).toBeDefined();
    await unlink(file);
  });

  it('interpolates ${VAR} placeholders from environment variables', async () => {
    process.env.TEST_RABBIT_URL = 'amqp://envhost:5672';
    const file = await writeTmp(
      'interp.yaml',
      `
buses:
  default:
    type: rabbitmq
    url: \${TEST_RABBIT_URL}
tools: {}
`,
    );
    const config = await loadConfig({ configPath: file, cliOverrides: {} });
    expect((config.buses['default'] as { url: string }).url).toBe('amqp://envhost:5672');
    delete process.env.TEST_RABBIT_URL;
    await unlink(file);
  });

  it('throws when a referenced environment variable is not set', async () => {
    delete process.env.MISSING_VAR;
    const file = await writeTmp(
      'missing-env.yaml',
      `
buses:
  default:
    type: rabbitmq
    url: \${MISSING_VAR}
tools: {}
`,
    );
    await expect(loadConfig({ configPath: file, cliOverrides: {} })).rejects.toThrow(
      "'MISSING_VAR' is not set",
    );
    await unlink(file);
  });

  it('throws when the config file fails schema validation', async () => {
    const file = await writeTmp(
      'bad-schema.yaml',
      `
buses:
  default:
    type: unknown-type
    url: amqp://localhost
tools: {}
`,
    );
    await expect(loadConfig({ configPath: file, cliOverrides: {} })).rejects.toThrow(
      'Config validation failed',
    );
    await unlink(file);
  });
});

// ── loadConfig — env var bus ──────────────────────────────────────────────────

describe('loadConfig — environment variable bus', () => {
  beforeEach(() => {
    delete process.env.IRON_MONKEY_BUS_URL;
    delete process.env.IRON_MONKEY_BUS_USER;
    delete process.env.IRON_MONKEY_BUS_PASS;
    delete process.env.IRON_MONKEY_SCHEMAS;
  });

  afterEach(() => {
    delete process.env.IRON_MONKEY_BUS_URL;
    delete process.env.IRON_MONKEY_BUS_USER;
    delete process.env.IRON_MONKEY_BUS_PASS;
    delete process.env.IRON_MONKEY_SCHEMAS;
  });

  it('builds a RabbitMQ bus config from IRON_MONKEY_BUS_URL', async () => {
    process.env.IRON_MONKEY_BUS_URL = 'amqp://rabbit.local:5672';
    const config = await loadConfig(emptyOptions);
    expect(config.buses['default']).toMatchObject({
      type: 'rabbitmq',
      url: 'amqp://rabbit.local:5672',
    });
  });

  it('includes auth when IRON_MONKEY_BUS_USER and PASS are set', async () => {
    process.env.IRON_MONKEY_BUS_URL = 'amqp://rabbit.local:5672';
    process.env.IRON_MONKEY_BUS_USER = 'admin';
    process.env.IRON_MONKEY_BUS_PASS = 'password';
    const config = await loadConfig(emptyOptions);
    expect(config.buses['default']).toMatchObject({
      auth: { username: 'admin', password: 'password' },
    });
  });

  it('builds a Kafka bus config from a kafka:// URL', async () => {
    process.env.IRON_MONKEY_BUS_URL = 'kafka://kafka.local:9092';
    const config = await loadConfig(emptyOptions);
    expect(config.buses['default']).toMatchObject({ type: 'kafka', brokers: ['kafka.local:9092'] });
  });

  it('sets schemasPath from IRON_MONKEY_SCHEMAS', async () => {
    process.env.IRON_MONKEY_SCHEMAS = '/custom/schemas';
    const config = await loadConfig(emptyOptions);
    expect(config.schemasPath).toBe('/custom/schemas');
  });
});

// ── loadConfig — CLI overrides ────────────────────────────────────────────────

describe('loadConfig — CLI overrides', () => {
  it('applies conduitUrl override', async () => {
    const config = await loadConfig({
      cliOverrides: { conduitUrl: 'https://conduit.example.com', conduitToken: 'tok' },
    });
    expect(config.conduit?.url).toBe('https://conduit.example.com');
    expect(config.conduit?.token).toBe('tok');
  });

  it('applies schemasPath override', async () => {
    const config = await loadConfig({ cliOverrides: { schemasPath: '/my/schemas' } });
    expect(config.schemasPath).toBe('/my/schemas');
  });
});
