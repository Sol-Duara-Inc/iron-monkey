/**
 * @module loaders/expression.loader
 * Loads and indexes CDrus expression bundles from a directory of YAML files,
 * then exposes them through a registry that resolves bundle references using
 * CDrus path-style identity notation: `expression`, `author/expression`, or
 * `group/author/expression`. Bundles are discovered by scanning for `.yaml` /
 * `.yml` files and validated against the expression bundle schema before
 * indexing. Identity is read from the YAML content (`group`, `author`,
 * `expression` fields), not inferred from the filename.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import { expressionBundleSchema } from '../expressions/schema.js';
import type { ExpressionBundle, BundleEventItem } from '../expressions/types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvConstructor = (Ajv as any).default ?? Ajv;
const ajv = new AjvConstructor({ allErrors: true });
const validateBundleSchema = ajv.compile(expressionBundleSchema);

/** Returns the default `expressions/` directory relative to the compiled output. */
function defaultExpressionsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // dist/loaders/expression.loader.js -> ../../expressions
  return resolve(dirname(thisFile), '../../expressions');
}

/**
 * Extracts the `noun.verb` key from a fully-qualified CDEvent type string such
 * as `dev.cdevents.build.started.0.5.1`. Used for collision detection in
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

  const bundle = parsed as ExpressionBundle;

  // Detect noun.verb collisions without explicit id disambiguation (event items only)
  const nounVerbCount = new Map<string, number>();
  for (const ev of bundle.produces) {
    if (!('event' in ev)) continue;
    const nv = nounVerbFromType(ev.event);
    nounVerbCount.set(nv, (nounVerbCount.get(nv) ?? 0) + 1);
  }
  for (const [nv, count] of nounVerbCount.entries()) {
    if (count > 1) {
      const withoutId = bundle.produces.filter(
        (ev): ev is BundleEventItem => 'event' in ev && nounVerbFromType(ev.event) === nv && !ev.id,
      );
      if (withoutId.length > 0) {
        throw new Error(
          `Expression bundle '${bundle.expression}' at ${filePath}: ` +
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
   * Resolves a path-style bundle reference to the matching bundle.
   *
   * Three reference forms are accepted (from least to most qualified):
   * - `'build'` — matches by expression name alone (errors if ambiguous)
   * - `'dsanyika/build'` — matches by author + expression name
   * - `'sol-duara/dsanyika/build'` — fully-qualified group/author/expression
   *
   * @param ref - Path-style reference string.
   * @returns The matching {@link ExpressionBundle}.
   * @throws {Error} If no matching bundle is found or the reference is ambiguous.
   */
  resolve(ref: string): ExpressionBundle;

  /**
   * Like {@link resolve} but uses the caller's `group` and `author` as a
   * tiebreaker when a bare expression name matches multiple bundles. The lookup
   * order for bare names is:
   *   1. Exact single match (no ambiguity) — used as-is.
   *   2. Filter to bundles whose `author` equals `context.author`.
   *   3. Filter to bundles whose `group` and `author` both match.
   *   4. Throw an ambiguity error if still unresolved.
   *
   * Already-qualified refs (two- or three-part) bypass context entirely.
   *
   * @param ref - Path-style reference string.
   * @param context - The calling bundle's or workflow's identity.
   * @returns The matching {@link ExpressionBundle}.
   */
  resolveWithContext(ref: string, context: { group: string; author: string }): ExpressionBundle;

  /**
   * Lists all indexed bundles as `{ name, group, author }` records, useful for
   * diagnostics and `--list-expressions` CLI output. `name` is the expression
   * name component of the identity tuple.
   */
  list(): { name: string; group: string; author: string }[];
}

/** Internal representation of an indexed bundle with its parsed identity. */
interface IndexedBundle {
  /** Expression name (the `expression` field value). */
  name: string;
  /** Group component of the identity tuple. */
  group: string;
  /** Author component of the identity tuple. */
  author: string;
  /** The fully parsed bundle object. */
  bundle: ExpressionBundle;
}

/**
 * Scans a directory of expression bundle YAML files, validates and indexes
 * them, and returns a resolver registry. All `.yaml` / `.yml` files are
 * considered; identity is read from the YAML content. Files that fail
 * validation throw immediately.
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
    const filePath = join(expressionsDir, file);
    const bundle = loadBundle(filePath);
    indexed.push({ name: bundle.expression, group: bundle.group, author: bundle.author, bundle });
  }

  return {
    resolve(ref: string): ExpressionBundle {
      const parts = ref.split('/');
      let candidates: IndexedBundle[];

      if (parts.length === 1) {
        // expression name only
        candidates = indexed.filter((b) => b.name === parts[0]);
        if (candidates.length > 1) {
          const identities = candidates.map((b) => `${b.group}/${b.author}/${b.name}`).join(', ');
          throw new Error(
            `Ambiguous expression reference '${ref}': multiple bundles match — ${identities}. ` +
              `Use a more qualified path (author/expression or group/author/expression).`,
          );
        }
      } else if (parts.length === 2) {
        // author/expression
        candidates = indexed.filter((b) => b.author === parts[0] && b.name === parts[1]);
      } else if (parts.length === 3) {
        // group/author/expression
        candidates = indexed.filter(
          (b) => b.group === parts[0] && b.author === parts[1] && b.name === parts[2],
        );
      } else {
        throw new Error(
          `Invalid expression reference '${ref}': expected 'expression', 'author/expression', ` +
            `or 'group/author/expression'.`,
        );
      }

      if (candidates.length === 0) {
        throw new Error(`No expression bundle found for '${ref}'. Searched in ${expressionsDir}.`);
      }

      return candidates[0].bundle;
    },

    resolveWithContext(ref: string, context: { group: string; author: string }): ExpressionBundle {
      const parts = ref.split('/');
      if (parts.length > 1) {
        // Already qualified — delegate to resolve()
        return this.resolve(ref);
      }

      const matches = indexed.filter((b) => b.name === ref);
      if (matches.length === 0) {
        throw new Error(`No expression bundle found for '${ref}'. Searched in ${expressionsDir}.`);
      }
      if (matches.length === 1) {
        return matches[0].bundle;
      }

      // Ambiguous — prefer same author first, then same group + author
      const byAuthor = matches.filter((b) => b.author === context.author);
      if (byAuthor.length === 1) return byAuthor[0].bundle;

      const byGroupAuthor = matches.filter(
        (b) => b.group === context.group && b.author === context.author,
      );
      if (byGroupAuthor.length === 1) return byGroupAuthor[0].bundle;

      const identities = matches.map((b) => `${b.group}/${b.author}/${b.name}`).join(', ');
      throw new Error(
        `Ambiguous expression reference '${ref}': multiple bundles match — ${identities}. ` +
          `Use a more qualified path (author/expression or group/author/expression).`,
      );
    },

    list(): { name: string; group: string; author: string }[] {
      return indexed.map((b) => ({ name: b.name, group: b.group, author: b.author }));
    },
  };
}
