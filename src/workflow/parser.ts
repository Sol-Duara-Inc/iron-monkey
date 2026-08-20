/**
 * @module workflow/parser
 * Parses and schema-validates workflow YAML files. Resolution of the
 * `produces` grammar into chains is {@link resolveChainTree}'s job
 * (`workflow/chain-tree.ts`) — the legacy flat resolver was removed at CDrus
 * 0.1.0 adoption because it silently dropped `spawn`/`detach` chains.
 */

import { validateWorkflowDoc } from './schema.js';
import { readTextFileSync, parseYaml, formatAjvErrorLine } from '../util/yaml-file.js';
import type { WorkflowFile } from './types.js';

/**
 * Reads, YAML-parses, and schema-validates a workflow file. Provides
 * Proleptic-aware error messages for common mistakes such as using `bus` or
 * `stages` keys that are not permitted in the Proleptic Event Orchestrator paradigm.
 *
 * @param filePath - Absolute or relative path to the workflow YAML file.
 * @returns The parsed and validated {@link WorkflowFile}.
 * @throws {Error} If the file cannot be read, fails YAML parsing, or fails
 *   schema validation.
 */
export async function validateWorkflow(filePath: string): Promise<WorkflowFile> {
  const raw = readTextFileSync(filePath, 'Cannot read workflow file');
  const parsed = parseYaml(raw, (cause) => `Failed to parse workflow YAML: ${cause}`);

  const valid = validateWorkflowDoc(parsed);
  if (!valid) {
    const errors = validateWorkflowDoc.errors
      ?.map(
        (e: {
          instancePath: string;
          message?: string;
          keyword?: string;
          params?: Record<string, unknown>;
        }) => {
          if (e.keyword === 'additionalProperties') {
            const prop = e.params?.additionalProperty as string | undefined;
            if (prop === 'bus') {
              return `  ${e.instancePath || '(root)'}: 'bus' field is not allowed — bus is selected via --bus flag or IRON_MONKEY_BUS_NAME env var (Proleptic Event Orchestrator paradigm)`;
            }
            if (prop === 'stages') {
              return `  ${e.instancePath || '(root)'}: 'stages' field is not allowed — use 'produces' instead (Proleptic Event Orchestrator paradigm)`;
            }
          }
          return formatAjvErrorLine(e);
        },
      )
      .join('\n');
    throw new Error(`Workflow validation failed:\n${errors}`);
  }

  return parsed as WorkflowFile;
}

/**
 * A flat, fully resolved CDEvent descriptor accepted by `buildManifest` as a
 * convenience input for programmatic callers that assemble simple sequences
 * by hand (no chains involved). The live path resolves workflows with
 * `resolveChainTree` after expanding expression references and
 * applying workflow defaults and per-event overrides.
 */
export interface ResolvedEvent {
  /**
   * Stable workflow-level identifier for this event (noun-verb slug, e.g.
   * `'build-started'`). De-duplicated with a counter suffix when the same
   * noun-verb appears more than once in the workflow.
   */
  id: string;
  /** Fully-qualified CDEvent type string, e.g. `dev.cdevents.build.started.0.3.0`. */
  type: string;
  /** Tool identifier whose `source` URI is looked up from the config `tools` map. */
  tool: string;
  /**
   * CDEvents `source` URI. Empty string when not set by the workflow; the
   * manifest builder falls back to the config tool source in that case.
   */
  source: string;
  /** Pipeline or stage name from the workflow for manifest `stageId`. */
  pipeline: string;
  /**
   * Upper timing bound: the emitter will not wait longer than this many
   * milliseconds after the previous event before emitting this one.
   */
  timeout_ms: number;
  /**
   * Lower timing bound: the emitter always waits at least this many
   * milliseconds after the previous event before emitting this one.
   */
  min_wait_ms: number;
  /** Resolved subject identity and content merged from defaults and overrides. */
  subject: { id: string; content?: Record<string, unknown> };
  /** Whether this event originated from a direct `event:` item or an `expression:` expansion. */
  origin: 'event' | 'expression';
  /**
   * The path-style CDrus identity reference string when `origin` is
   * `'expression'` (e.g. `'build'`, `'iron-monkey/build'`); absent for
   * direct event items.
   */
  expressionRef?: string;
}
