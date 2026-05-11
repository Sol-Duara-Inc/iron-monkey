/**
 * @module loaders/schema.loader
 * Scans a directory of CDEvent JSON schema files and builds a `Map` keyed by
 * event type string. The type string is extracted from the schema's
 * `properties.context.properties.type.enum[0]` field, which is the convention
 * used in the official CDEvents schema repository.
 */

import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMAS_DIR = path.resolve(__dirname, '../../schemas/cdevents');

/**
 * Reads all `.json` files from `dir`, parses them, extracts the CDEvent type
 * string from each schema, and returns a map of `type → schema`. Files that
 * cannot be parsed or do not follow the per-event CDEvent schema convention
 * (e.g. `baseevent.json`) are silently skipped.
 *
 * @param dir - Absolute path to the directory containing CDEvent JSON schemas.
 * @returns A `Map<string, unknown>` from event type string to raw schema object.
 *   Returns an empty map if `dir` does not exist.
 */
export async function loadSchemasFromDir(dir: string): Promise<Map<string, unknown>> {
  const schemas = new Map<string, unknown>();

  if (!existsSync(dir)) {
    return schemas;
  }

  const files = await readdir(dir);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    const content = await readFile(path.join(dir, file), 'utf-8');
    let schema: unknown;
    try {
      schema = JSON.parse(content);
    } catch {
      continue;
    }

    const typeString = extractTypeString(schema);
    if (typeString) {
      schemas.set(typeString, schema);
    }
  }

  return schemas;
}

/**
 * Attempts to extract the CDEvent type string from a JSON schema object by
 * reading `properties.context.properties.type.enum[0]`. Returns `null` for
 * schemas that don't follow this convention (e.g. the shared `baseevent.json`).
 *
 * @param schema - Raw parsed JSON schema object.
 * @returns The event type string (e.g. `'dev.cdevents.build.started.0.1.0'`),
 *   or `null` if the schema does not contain a recognisable type enum.
 */
function extractTypeString(schema: unknown): string | null {
  try {
    const s = schema as Record<string, unknown>;
    const context = s['properties'] as Record<string, unknown>;
    const contextProps = (context['context'] as Record<string, unknown>)['properties'] as Record<
      string,
      unknown
    >;
    const typeEnum = (contextProps['type'] as Record<string, unknown>)['enum'] as string[];
    if (Array.isArray(typeEnum) && typeEnum.length > 0 && typeof typeEnum[0] === 'string') {
      return typeEnum[0];
    }
  } catch {
    // schema doesn't follow per-event convention (e.g. baseevent.json)
  }
  return null;
}

/**
 * Returns the default CDEvent schema directory bundled with Iron Monkey
 * (`schemas/cdevents/` relative to the package root).
 *
 * @returns The absolute path to the bundled schemas directory.
 */
export async function getDefaultSchemasDir(): Promise<string> {
  return DEFAULT_SCHEMAS_DIR;
}
