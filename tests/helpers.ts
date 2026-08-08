/**
 * Shared test scaffolding. Not a test file (vitest only collects files whose
 * names end in `.test.ts`); imported by suites that need throwaway
 * directories or minimal bundle YAML without re-rolling the same helpers.
 */
import { mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';

/** Creates a unique throwaway directory under the OS tmpdir. */
export async function makeTmpDir(prefix: string): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Renders a minimal, hint-satisfiable expression bundle YAML. The default
 * single event is a full `build.started`+`finished` pair ONLY when the name
 * demands it — callers pass explicit events for hint-carrying names.
 */
export function bundleYaml(
  name: string,
  opts: { group?: string; author?: string; events?: string[] } = {},
): string {
  const { group = 'sol-duara', author = 'dsanyika' } = opts;
  const events = opts.events ?? ['dev.cdevents.build.started.0.3.0'];
  const produces = events.map((e) => `  - event: ${e}`).join('\n');
  return `group: ${group}\nauthor: ${author}\nexpression: ${name}\nproduces:\n${produces}\n`;
}
