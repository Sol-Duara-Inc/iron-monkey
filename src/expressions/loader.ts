/**
 * @module expressions/loader
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
import { createAjv } from '../util/ajv.js';
import { getLogger } from '../logger/index.js';
import { expressionBundleSchema } from './schema.js';
import type { ExpressionBundle } from './types.js';

const validateBundleSchema = createAjv().compile(expressionBundleSchema);

/**
 * Standard-library fallback identity used by {@link ExpressionRegistry.resolveWithContext}
 * when a bare expression reference does not resolve under the caller's own
 * (group, author) identity. This is a runtime resolution convention, not a
 * schema constraint — it can evolve without touching the schema.
 *
 * Matches Junction Box's CDrus resolver behaviour (see
 * `junction-box/src/workflow-definition/expression-index.ts`).
 */
export const STD_LIB_GROUP = 'example-group';
export const STD_LIB_AUTHOR = 'user';

/** Returns the default `expressions/` directory relative to the compiled output. */
function defaultExpressionsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // dist/expressions/loader.js -> ../../expressions
  return resolve(dirname(thisFile), '../../expressions');
}

/**
 * Extracts the `noun.verb` key from a fully-qualified CDEvent type string such
 * as `dev.cdevents.build.started.0.3.0`. Used for collision detection in
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
 * Duplicate `noun.verb` events without explicit `id` fields are **accepted**
 * — position in the `produces` array disambiguates them, and downstream code
 * (`resolveProduces` in the workflow parser) allocates unique positional ids
 * (`noun-verb`, `noun-verb-1`, `noun-verb-2`, …) at expansion time. Authors who
 * want explicit handles can still supply an `id` and that wins over the
 * positional default.
 *
 * @param filePath - Absolute path to the `.yaml` bundle file.
 * @returns The parsed and validated {@link ExpressionBundle}.
 * @throws {Error} If the file cannot be read, fails YAML parsing, or fails
 *   schema validation.
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

  return parsed as ExpressionBundle;
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
   * Resolves a bundle reference using the caller's `(group, author)` as the
   * resolution context. The reference shape determines the candidate set:
   *
   * | Form | Candidates tried, in order | Fallback? |
   * |---|---|---|
   * | `'build'` | `(ctx.group, ctx.author, build)`, `(example-group, user, build)` | Yes — std-lib |
   * | `'dsanyika/build'` | `(ctx.group, dsanyika, build)` | No |
   * | `'sol-duara/dsanyika/build'` | `(sol-duara, dsanyika, build)` | No |
   *
   * The first candidate that exists in the registry wins. If no candidate
   * resolves, an error is thrown — matches Junction Box's CDrus resolver
   * semantics. See `STD_LIB_GROUP` / `STD_LIB_AUTHOR` for the fallback identity.
   *
   * @param ref - Path-style reference.
   * @param context - The calling workflow's or expression's identity.
   * @returns The matching bundle.
   * @throws {Error} If the reference is malformed (4+ slash-separated parts)
   *   or no candidate identity resolves.
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
 * considered; identity is read from the YAML content.
 *
 * Per-file resilience: an individual file that fails to read, parse, or
 * validate is **skipped with a warning**, not fatal — one stray or malformed
 * bundle must never break an entire run. The registry is built from the files
 * that load cleanly. (`loadBundle` itself stays strict and throws; only this
 * registry layer is tolerant.) A workflow that references a skipped expression
 * still fails clearly at resolution time.
 *
 * The directory is resolved in this order:
 * 1. `IRON_MONKEY_EXPRESSIONS` environment variable.
 * 2. The explicit `dir` argument.
 * 3. The package's bundled `expressions/` directory.
 *
 * @param dir - Optional path to the expressions directory.
 * @returns A registry populated from every bundle that loaded cleanly.
 */
export function loadExpressionRegistry(dir?: string): ExpressionRegistry {
  const expressionsDir = process.env.IRON_MONKEY_EXPRESSIONS ?? dir ?? defaultExpressionsDir();
  const logger = getLogger();

  let files: string[] = [];
  try {
    files = readdirSync(expressionsDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch {
    // directory may not exist in some test environments; resolve() will fail clearly
  }

  const indexed: IndexedBundle[] = [];
  let skipped = 0;

  for (const file of files) {
    const filePath = join(expressionsDir, file);
    try {
      const bundle = loadBundle(filePath);
      indexed.push({ name: bundle.expression, group: bundle.group, author: bundle.author, bundle });
    } catch (err) {
      // Skip this one file but keep loading the rest — fail-loud in logs,
      // fail-soft for the run.
      skipped += 1;
      logger.warn(
        { file: filePath, err: (err as Error).message },
        'skipping invalid expression bundle',
      );
    }
  }

  if (skipped > 0) {
    logger.warn(
      { indexed: indexed.length, files: files.length, skipped },
      `indexed ${indexed.length} expression(s) from ${files.length} file(s) (${skipped} skipped)`,
    );
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
      // Build the ordered candidate identity list per CDrus resolution rules.
      // Position in this list is significant: first match wins.
      let candidates: { group: string; author: string; name: string }[];

      if (parts.length === 1) {
        // Bare ref: caller's identity first, std-lib fallback second.
        candidates = [
          { group: context.group, author: context.author, name: parts[0] },
          { group: STD_LIB_GROUP, author: STD_LIB_AUTHOR, name: parts[0] },
        ];
      } else if (parts.length === 2) {
        // Author-qualified within the caller's group. No fallback — explicit
        // author means the caller is opting out of the std-lib search.
        candidates = [{ group: context.group, author: parts[0], name: parts[1] }];
      } else if (parts.length === 3) {
        // Fully qualified. Exact match only.
        candidates = [{ group: parts[0], author: parts[1], name: parts[2] }];
      } else {
        throw new Error(
          `Invalid expression reference '${ref}': expected 'expression', 'author/expression', ` +
            `or 'group/author/expression'.`,
        );
      }

      for (const c of candidates) {
        const match = indexed.find(
          (b) => b.group === c.group && b.author === c.author && b.name === c.name,
        );
        if (match) return match.bundle;
      }

      // No candidate resolved. Surface the candidates we tried so the error
      // points the caller at what was searched, not just what wasn't found.
      const tried = candidates.map((c) => `${c.group}/${c.author}/${c.name}`).join(', ');
      throw new Error(
        `No expression bundle resolved for '${ref}' under context ` +
          `${context.group}/${context.author}. Tried: ${tried}. Searched in ${expressionsDir}.`,
      );
    },

    list(): { name: string; group: string; author: string }[] {
      return indexed.map((b) => ({ name: b.name, group: b.group, author: b.author }));
    },
  };
}
