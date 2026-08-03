/**
 * @module hints/table
 * Loads and validates the versioned name-hint keyword table (RFC §4.1.1).
 * The table is data, not code: it ships beside the CDrus schemas as
 * `schemas/cdrus/name-hints.table.json` and is updated by a reviewed
 * table-version bump when CDEvents releases add or change subjects — never by
 * hot-swapping at run time.
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { HintSubject, HintTable } from './types.js';

/** Returns the bundled table path relative to the compiled output. */
function defaultTablePath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // dist/hints/table.js -> ../../schemas/cdrus/name-hints.table.json
  return resolve(dirname(thisFile), '../../schemas/cdrus/name-hints.table.json');
}

/**
 * Validates an unknown value as a {@link HintTable}.
 *
 * @param data - Parsed JSON of a candidate table.
 * @returns The validated table.
 * @throws {Error} When the shape is not a usable keyword table.
 */
export function parseHintTable(data: unknown): HintTable {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('name-hint table must be a JSON object');
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.version !== 'string' || obj.version.length === 0) {
    throw new Error("name-hint table must declare a non-empty string 'version'");
  }
  if (obj.subjects === null || typeof obj.subjects !== 'object' || Array.isArray(obj.subjects)) {
    throw new Error("name-hint table must declare a 'subjects' object");
  }

  const subjects: Record<string, HintSubject> = {};
  for (const [name, value] of Object.entries(obj.subjects as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`name-hint table subject '${name}' must be an object`);
    }
    const s = value as Record<string, unknown>;
    if (!Array.isArray(s.predicates) || s.predicates.some((p) => typeof p !== 'string')) {
      throw new Error(`name-hint table subject '${name}' must declare a string[] 'predicates'`);
    }
    const begin = s.begin ?? null;
    const end = s.end ?? null;
    if (begin !== null && typeof begin !== 'string') {
      throw new Error(`name-hint table subject '${name}': 'begin' must be a string or null`);
    }
    if (end !== null && typeof end !== 'string') {
      throw new Error(`name-hint table subject '${name}': 'end' must be a string or null`);
    }
    if ((begin === null) !== (end === null)) {
      throw new Error(`name-hint table subject '${name}': 'begin' and 'end' must be paired`);
    }
    subjects[name] = { predicates: s.predicates as string[], begin, end };
  }

  return { version: obj.version, subjects };
}

/**
 * Loads the bundled default keyword table from `schemas/cdrus/`.
 *
 * @param path - Optional explicit table path (used by tests and by consumers
 *   pinning a different table version).
 * @returns The validated table.
 * @throws {Error} When the file is missing, unparsable, or malformed.
 */
export function loadHintTable(path?: string): HintTable {
  const tablePath = path ?? defaultTablePath();
  let raw: string;
  try {
    raw = readFileSync(tablePath, 'utf-8');
  } catch {
    throw new Error(`Cannot read name-hint table: ${tablePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse name-hint table at ${tablePath}: ${(err as Error).message}`);
  }
  return parseHintTable(parsed);
}
