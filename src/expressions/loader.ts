/**
 * @module expressions/loader
 * Loads and indexes CDrus expression bundles from a directory of YAML files,
 * then exposes them through a registry that resolves bundle references of the
 * form `<name>:<semver-range>`. Bundles are discovered by filename pattern
 * `<name>-<major>.<minor>.<patch>.yaml` and validated against the expression
 * bundle schema before indexing.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import { expressionBundleSchema } from './schema.js';
import type { ExpressionBundle, ExpressionBundleFile } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvConstructor = (Ajv as any).default ?? Ajv;
const ajv = new AjvConstructor({ allErrors: true });
const validateBundleSchema = ajv.compile(expressionBundleSchema);

/** Returns the default `expressions/` directory relative to the compiled output. */
function defaultExpressionsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // dist/expressions/loader.js -> ../../expressions  (or src/expressions/loader.ts -> ../../expressions)
  return resolve(dirname(thisFile), '../../expressions');
}

/**
 * Parses a version string into a `[major, minor, patch]` tuple.
 *
 * @throws {Error} If the string is not a valid three-part numeric semver.
 */
function parseSemver(version: string): [number, number, number] {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some((n) => isNaN(n))) {
    throw new Error(`Invalid semver: '${version}'`);
  }
  return [parts[0], parts[1], parts[2]];
}

/**
 * Returns `true` when `version` satisfies `range`. Supports caret (`^`)
 * ranges and exact matches; other range syntaxes are not implemented.
 */
function satisfiesRange(version: string, range: string): boolean {
  if (range.startsWith('^')) {
    const [rv0, rv1, rv2] = parseSemver(range.slice(1));
    const [v0, v1, v2] = parseSemver(version);
    if (rv0 > 0) return v0 === rv0 && (v1 > rv1 || (v1 === rv1 && v2 >= rv2));
    if (rv1 > 0) return v0 === 0 && v1 === rv1 && v2 >= rv2;
    return v0 === 0 && v1 === 0 && v2 === rv2;
  }
  // exact match
  return version === range;
}

/**
 * Compares two semver strings. Returns a negative number if `a < b`, zero if
 * equal, or positive if `a > b`. Used to select the highest compatible bundle
 * version when multiple satisfy a range.
 */
function semverCompare(a: string, b: string): number {
  const [a0, a1, a2] = parseSemver(a);
  const [b0, b1, b2] = parseSemver(b);
  return a0 !== b0 ? a0 - b0 : a1 !== b1 ? a1 - b1 : a2 - b2;
}

/**
 * Extracts the `noun.verb` key from a fully-qualified CDEvent type string such
 * as `dev.cdevents.build.started.0.1.0`. Used for collision detection in
 * expression bundles and for generating default `workflowEventId` values.
 *
 * @param eventType - A CDEvent type string or similar dot-separated identifier.
 * @returns The `noun.verb` portion, e.g. `'build.started'`.
 */
export function nounVerbFromType(eventType: string): string {
  const parts = eventType.split('.');
  // dev.cdevents.<noun>.<verb>.<major>.<minor>.<patch>
  if (parts.length >= 5 && parts[0] === 'dev' && parts[1] === 'cdevents') {
    return `${parts[2]}.${parts[3]}`;
  }
  return parts.slice(-5, -3).join('.');
}

/**
 * Reads and validates a single expression bundle YAML file.
 *
 * @param filePath - Absolute path to the `.yaml` bundle file.
 * @returns The parsed and validated {@link ExpressionBundle}.
 * @throws {Error} If the file cannot be read, fails YAML parsing, fails schema
 *   validation, or contains duplicate `noun.verb` events without explicit `id`
 *   fields.
 */
function loadBundle(filePath: string): ExpressionBundle {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    throw new Error(`Cannot read expression bundle: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse expression bundle YAML at ${filePath}: ${(err as Error).message}`,
    );
  }

  const valid = validateBundleSchema(parsed);
  if (!valid) {
    const errors = validateBundleSchema.errors
      ?.map(
        (e: { instancePath: string; message?: string }) =>
          `  ${e.instancePath || '(root)'}: ${e.message}`,
      )
      .join('\n');
    throw new Error(`Expression bundle schema validation failed at ${filePath}:\n${errors}`);
  }

  const bundle = (parsed as ExpressionBundleFile).expression;

  // Detect noun.verb collisions without explicit id disambiguation
  const nounVerbCount = new Map<string, number>();
  for (const ev of bundle.produces) {
    const nv = nounVerbFromType(ev.event);
    nounVerbCount.set(nv, (nounVerbCount.get(nv) ?? 0) + 1);
  }
  for (const [nv, count] of nounVerbCount.entries()) {
    if (count > 1) {
      const withoutId = bundle.produces.filter((ev) => nounVerbFromType(ev.event) === nv && !ev.id);
      if (withoutId.length > 0) {
        throw new Error(
          `Expression bundle '${bundle.name}' at ${filePath}: ` +
            `events with duplicate noun.verb '${nv}' must each have an explicit 'id' field.`,
        );
      }
    }
  }

  return bundle;
}

/**
 * In-memory registry of loaded expression bundles. Returned by
 * {@link loadExpressionRegistry} and consumed by the workflow parser to expand
 * `expression:` produce items into concrete CDEvent sequences.
 */
export interface ExpressionRegistry {
  /**
   * Resolves a bundle reference string to the highest-version bundle that
   * satisfies the given semver range.
   *
   * @param ref - Reference in the format `<name>:<semver-range>`, e.g.
   *   `'github-actions:^1.0.0'`.
   * @returns The matching {@link ExpressionBundle}.
   * @throws {Error} If the reference is malformed or no matching bundle is
   *   found in the registry.
   */
  resolve(ref: string): ExpressionBundle;

  /**
   * Lists all indexed bundles as `{ name, version }` pairs, useful for
   * diagnostics and `--list-expressions` CLI output.
   */
  list(): { name: string; version: string }[];
}

/** Internal representation of an indexed bundle with its parsed metadata. */
interface IndexedBundle {
  /** Bundle name as declared in the YAML `expression.name` field. */
  name: string;
  /** Semver version string declared in the YAML `expression.version` field. */
  version: string;
  /** The fully parsed bundle object. */
  bundle: ExpressionBundle;
}

/**
 * Scans a directory of expression bundle YAML files, validates and indexes
 * them, and returns a resolver registry. Files must be named
 * `<name>-<major>.<minor>.<patch>.yaml`; others are silently skipped.
 *
 * The directory is resolved in this order:
 * 1. `IRON_MONKEY_EXPRESSIONS` environment variable.
 * 2. The explicit `dir` argument.
 * 3. The package's bundled `expressions/` directory.
 *
 * @param dir - Optional path to the expressions directory.
 * @returns A fully populated {@link ExpressionRegistry}.
 * @throws {Error} If any discovered bundle fails validation.
 */
export function loadExpressionRegistry(dir?: string): ExpressionRegistry {
  const expressionsDir = process.env.IRON_MONKEY_EXPRESSIONS ?? dir ?? defaultExpressionsDir();

  let files: string[] = [];
  try {
    files = readdirSync(expressionsDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch {
    // directory may not exist in some test environments; resolve() will fail clearly
  }

  const indexed: IndexedBundle[] = [];

  for (const file of files) {
    const match = file.match(/^(.+)-(\d+\.\d+\.\d+)\.ya?ml$/);
    if (!match) continue;
    const filePath = join(expressionsDir, file);
    const bundle = loadBundle(filePath);
    indexed.push({ name: bundle.name, version: bundle.version, bundle });
  }

  return {
    resolve(ref: string): ExpressionBundle {
      const colonIdx = ref.indexOf(':');
      if (colonIdx === -1) {
        throw new Error(
          `Invalid expression reference '${ref}': expected format '<name>:<semver-range>'`,
        );
      }
      const name = ref.slice(0, colonIdx);
      const range = ref.slice(colonIdx + 1);

      const candidates = indexed
        .filter((b) => b.name === name && satisfiesRange(b.version, range))
        .sort((a, b) => semverCompare(b.version, a.version));

      if (candidates.length === 0) {
        throw new Error(
          `No expression bundle found for '${ref}'. Searched ${expressionsDir}/${name}-*.yaml.`,
        );
      }

      return candidates[0].bundle;
    },

    list(): { name: string; version: string }[] {
      return indexed.map((b) => ({ name: b.name, version: b.version }));
    },
  };
}
