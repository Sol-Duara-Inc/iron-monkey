/**
 * @module util/yaml-file
 * The one implementation of the read → YAML-parse → report pipeline that four
 * loaders (workflow, expression bundles, config, repertoire) previously each
 * hand-rolled, plus the shared AJV error formatting. Message TEXT stays
 * caller-owned — every consumer kept its exact error wording when migrating
 * here, so tests and users see identical failures.
 */

import { readFileSync } from 'fs';
import yaml from 'js-yaml';

/**
 * Reads a UTF-8 text file, translating any read failure into
 * `"<errorPrefix>: <path>"` — the shape all loaders already used.
 */
export function readTextFileSync(filePath: string, errorPrefix: string): string {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    throw new Error(`${errorPrefix}: ${filePath}`);
  }
}

/**
 * Parses YAML, translating parse failures through the caller's message
 * builder so each loader keeps its established wording.
 */
export function parseYaml(raw: string, errorMessage: (cause: string) => string): unknown {
  try {
    return yaml.load(raw);
  } catch (err) {
    throw new Error(errorMessage((err as Error).message));
  }
}

/** The AJV error entry shape the formatters consume. */
export interface AjvErrorLike {
  instancePath: string;
  message?: string;
}

/** Formats one AJV error as the repo-standard `  <path>: <message>` line. */
export function formatAjvErrorLine(e: AjvErrorLike): string {
  return `  ${e.instancePath || '(root)'}: ${e.message}`;
}

/** Joins AJV errors into the repo-standard multi-line block. */
export function formatAjvErrors(errors: AjvErrorLike[] | null | undefined): string {
  return (errors ?? []).map(formatAjvErrorLine).join('\n');
}
