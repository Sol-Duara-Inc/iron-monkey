/**
 * @module repertoire/loader
 * Loads and validates a repertoire YAML file, then merges shared defaults with
 * per-pitch overrides to produce one RunOptions object per pitch.
 */

import { readFile } from 'fs/promises';
import yaml from 'js-yaml';
import type { RepertoireFile, RepertoirePitch } from './types.js';
import type { RunOptions } from '../emitter/runner.js';

/**
 * Reads and YAML-parses a repertoire file. Throws with a clear message if the
 * file is missing, unparseable, or missing the required `pitches` array.
 *
 * @param filePath - Path to the repertoire YAML file.
 * @returns The parsed {@link RepertoireFile}.
 */
export async function loadRepertoire(filePath: string): Promise<RepertoireFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    throw new Error(`Cannot read repertoire file: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`Invalid YAML in repertoire file ${filePath}: ${(err as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Repertoire file ${filePath} must be a YAML object`);
  }

  const doc = parsed as Record<string, unknown>;

  if (!Array.isArray(doc['pitches']) || doc['pitches'].length === 0) {
    throw new Error(`Repertoire file ${filePath} must contain a non-empty 'pitches' array`);
  }

  return doc as unknown as RepertoireFile;
}

/**
 * Merges the shared defaults from a {@link RepertoireFile} with each pitch's
 * own overrides, producing one {@link RunOptions} per pitch. Pitch-level
 * values always win over shared values.
 *
 * @param repertoire - The parsed repertoire file.
 * @param cliOverrides - Any options passed directly on the CLI that act as a
 *   base layer beneath shared (e.g. `--config`, `--log-level`).
 * @returns Array of `[workflowPath, RunOptions]` tuples in pitch order.
 */
export function buildPitchOptions(
  repertoire: RepertoireFile,
  cliOverrides: Partial<RunOptions> = {},
): Array<{ workflowPath: string; options: RunOptions }> {
  const shared = repertoire.shared ?? {};

  return repertoire.pitches.map((pitch: RepertoirePitch) => ({
    workflowPath: pitch.workflow,
    options: {
      ...cliOverrides,
      ...(shared.bus !== undefined && { bus: shared.bus }),
      ...(shared.conduit !== undefined && { conduit: shared.conduit }),
      ...(shared.interval !== undefined && { interval: shared.interval }),
      ...(shared.synth !== undefined && { synth: shared.synth }),
      ...(pitch.bus !== undefined && { bus: pitch.bus }),
      ...(pitch.conduit !== undefined && { conduit: pitch.conduit }),
      ...(pitch.seed !== undefined && { seed: pitch.seed }),
      ...(pitch.inject !== undefined && { inject: pitch.inject }),
      ...(pitch.manifest_out !== undefined && { manifestOut: pitch.manifest_out }),
      ...(pitch.interval !== undefined && { interval: pitch.interval }),
      ...(pitch.synth !== undefined && { synth: pitch.synth }),
    },
  }));
}
