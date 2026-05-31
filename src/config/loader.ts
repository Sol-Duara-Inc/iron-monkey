/**
 * @module config/loader
 * Loads, validates, and merges Iron Monkey runtime configuration from multiple
 * sources in priority order: CLI overrides > environment variables >
 * config file > built-in defaults. Supports JSON and YAML config files and
 * resolves `${ENV_VAR}` interpolations before schema validation.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { createAjv } from '../util/ajv.js';
import { configSchema } from './schema.js';
import type { IronMonkeyConfig, LoadConfigOptions } from './types.js';

const validateConfigSchema = createAjv({ formats: true }).compile(configSchema);

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Replaces `${VAR_NAME}` placeholders in a single string with the corresponding
 * process environment variable value.
 *
 * @param value - Raw string that may contain `${…}` placeholders.
 * @returns The string with all placeholders substituted.
 * @throws {Error} If any referenced environment variable is not set.
 */
function interpolateEnv(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (_, varName: string) => {
    const val = process.env[varName];
    if (val === undefined) {
      throw new Error(`Environment variable '${varName}' is not set (referenced in config)`);
    }
    return val;
  });
}

/**
 * Recursively walks an arbitrary config value and applies {@link interpolateEnv}
 * to every string leaf, leaving numbers, booleans, and `null` untouched.
 */
function interpolateObject(obj: unknown): unknown {
  if (typeof obj === 'string') return interpolateEnv(obj);
  if (Array.isArray(obj)) return obj.map(interpolateObject);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = interpolateObject(v);
    }
    return result;
  }
  return obj;
}

/**
 * Reads, parses, interpolates, and schema-validates a config file on disk.
 * Supports `.json` and `.yaml` / `.yml` formats.
 *
 * @param filePath - Absolute or relative path to the config file.
 * @returns Partial config extracted from the file.
 * @throws {Error} If the file cannot be read, parsed, or fails schema validation.
 */
async function loadFileConfig(filePath: string): Promise<Partial<IronMonkeyConfig>> {
  const content = await readFile(filePath, 'utf-8');
  const ext = path.extname(filePath).toLowerCase();

  let parsed: unknown;
  if (ext === '.json') {
    parsed = JSON.parse(content);
  } else {
    parsed = yaml.load(content);
  }

  parsed = interpolateObject(parsed);

  const valid = validateConfigSchema(parsed);
  if (!valid) {
    const errors = validateConfigSchema.errors
      ?.map(
        (e: { instancePath: string; message?: string }) =>
          `  ${e.instancePath || '(root)'}: ${e.message}`,
      )
      .join('\n');
    throw new Error(`Config validation failed:\n${errors}`);
  }

  return parsed as Partial<IronMonkeyConfig>;
}

/**
 * Constructs a partial config from well-known `IRON_MONKEY_*` environment
 * variables. This layer is applied after any config file and before CLI
 * overrides.
 *
 * Recognised variables: `IRON_MONKEY_CONDUIT_URL`, `IRON_MONKEY_CONDUIT_TOKEN`,
 * `IRON_MONKEY_BUS_URL`, `IRON_MONKEY_BUS_USER`, `IRON_MONKEY_BUS_PASS`,
 * `IRON_MONKEY_SCHEMAS`.
 */
function buildFromEnv(): Partial<IronMonkeyConfig> {
  const config: Partial<IronMonkeyConfig> = {};

  const conduitUrl = process.env.IRON_MONKEY_CONDUIT_URL;
  const conduitToken = process.env.IRON_MONKEY_CONDUIT_TOKEN;
  if (conduitUrl) {
    config.conduit = { url: conduitUrl, token: conduitToken };
  }

  const busUrl = process.env.IRON_MONKEY_BUS_URL;
  if (busUrl) {
    const user = process.env.IRON_MONKEY_BUS_USER;
    const pass = process.env.IRON_MONKEY_BUS_PASS;

    if (busUrl.startsWith('amqp')) {
      config.buses = {
        default: {
          type: 'rabbitmq',
          url: busUrl,
          ...(user && pass ? { auth: { username: user, password: pass } } : {}),
        },
      };
    } else if (busUrl.startsWith('kafka')) {
      const broker = busUrl.replace(/^kafka:\/\//, '');
      config.buses = { default: { type: 'kafka', brokers: [broker] } };
    }
  }

  const schemasPath = process.env.IRON_MONKEY_SCHEMAS;
  if (schemasPath) config.schemasPath = schemasPath;

  return config;
}

/**
 * Determines which named bus to use for event emission.
 *
 * Resolution order:
 * 1. The explicit `busName` argument (e.g. from `--bus` CLI flag).
 * 2. The `IRON_MONKEY_BUS_NAME` environment variable.
 * 3. `'default'` if a bus named `'default'` exists in config.
 * 4. The sole configured bus when exactly one is defined.
 *
 * @param config - Fully merged Iron Monkey config.
 * @param busName - Optional bus name hint (overrides all other resolution).
 * @returns The resolved bus name.
 * @throws {Error} If no bus is configured or multiple buses exist without a
 *   disambiguating name.
 */
export function resolveBusName(config: IronMonkeyConfig, busName?: string): string {
  if (busName) return busName;
  const envBus = process.env.IRON_MONKEY_BUS_NAME;
  if (envBus) return envBus;
  if (config.buses['default']) return 'default';
  const names = Object.keys(config.buses);
  if (names.length === 1) return names[0];
  if (names.length === 0) {
    throw new Error('No bus configured. Add a bus to your config file or set IRON_MONKEY_BUS_URL.');
  }
  throw new Error(
    'Multiple buses configured; specify one with --bus <name> or IRON_MONKEY_BUS_NAME env var.',
  );
}

/**
 * Loads and merges the full Iron Monkey configuration from all available
 * sources. Config file auto-discovery checks `iron-monkey.yaml` then
 * `iron-monkey.json` in the current working directory when no explicit path is
 * given.
 *
 * @param options - Controls which config file to read and which CLI overrides
 *   to apply on top.
 * @returns The fully merged {@link IronMonkeyConfig}.
 * @throws {Error} If a config file cannot be parsed or fails schema validation,
 *   or if a referenced `${ENV_VAR}` is not set.
 */
export async function loadConfig(options: LoadConfigOptions): Promise<IronMonkeyConfig> {
  const defaults: IronMonkeyConfig = {
    buses: {},
    tools: {},
  };

  let fileConfig: Partial<IronMonkeyConfig> = {};

  const configPath =
    options.configPath ??
    process.env.IRON_MONKEY_CONFIG ??
    (existsSync('iron-monkey.yaml') ? 'iron-monkey.yaml' : undefined) ??
    (existsSync('iron-monkey.json') ? 'iron-monkey.json' : undefined);

  if (configPath) {
    fileConfig = await loadFileConfig(configPath);
  }

  const envConfig = buildFromEnv();

  const merged: IronMonkeyConfig = {
    ...defaults,
    ...fileConfig,
    ...envConfig,
    buses: {
      ...defaults.buses,
      ...(fileConfig.buses ?? {}),
      ...(envConfig.buses ?? {}),
    },
    tools: {
      ...defaults.tools,
      ...(fileConfig.tools ?? {}),
    },
  };

  if (options.cliOverrides.conduitUrl) {
    merged.conduit = {
      url: options.cliOverrides.conduitUrl,
      token: options.cliOverrides.conduitToken ?? merged.conduit?.token,
    };
  }

  if (options.cliOverrides.schemasPath) {
    merged.schemasPath = options.cliOverrides.schemasPath;
  }

  return merged;
}
