/**
 * @module workflow/parser
 * Parses and validates workflow YAML files, then resolves the `produces` list
 * into a flat, ordered array of concrete CDEvent descriptors. Each item in
 * `produces` is either a direct `event` entry or an `expression` reference
 * that is expanded via the expression registry. Workflow-level `defaults` and
 * per-expression `overrides` are merged using a deep-merge strategy so more
 * specific values always win.
 */

import { readFile } from 'fs/promises';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import { workflowSchema } from './schema.js';
import { isEventItem, isExpressionItem } from './types.js';
import { nounVerbFromType } from '../expressions/loader.js';
import type { WorkflowFile, WorkflowDefaults } from './types.js';
import type { ExpressionRegistry } from '../expressions/loader.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvConstructor = (Ajv as any).default ?? Ajv;
const ajv = new AjvConstructor({ allErrors: true });
const validateWorkflowSchema = ajv.compile(workflowSchema);

/**
 * Reads, YAML-parses, and schema-validates a workflow file. Provides
 * Sympraxis-aware error messages for common mistakes such as using `bus` or
 * `stages` keys that are not permitted in the Sympraxis paradigm.
 *
 * @param filePath - Absolute or relative path to the workflow YAML file.
 * @returns The parsed and validated {@link WorkflowFile}.
 * @throws {Error} If the file cannot be read, fails YAML parsing, or fails
 *   schema validation.
 */
export async function validateWorkflow(filePath: string): Promise<WorkflowFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    throw new Error(`Cannot read workflow file: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`Failed to parse workflow YAML: ${(err as Error).message}`);
  }

  const valid = validateWorkflowSchema(parsed);
  if (!valid) {
    const errors = validateWorkflowSchema.errors
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
              return `  ${e.instancePath || '(root)'}: 'bus' field is not allowed — bus is selected via --bus flag or IRON_MONKEY_BUS_NAME env var (Sympraxis paradigm)`;
            }
            if (prop === 'stages') {
              return `  ${e.instancePath || '(root)'}: 'stages' field is not allowed — use 'produces' instead (Sympraxis paradigm)`;
            }
          }
          return `  ${e.instancePath || '(root)'}: ${e.message}`;
        },
      )
      .join('\n');
    throw new Error(`Workflow validation failed:\n${errors}`);
  }

  return parsed as WorkflowFile;
}

/**
 * A fully resolved CDEvent descriptor ready for manifest construction.
 * Produced by {@link resolveProduces} after expanding expression references and
 * applying workflow defaults and per-event overrides.
 */
export interface ResolvedEvent {
  /**
   * Stable workflow-level identifier for this event (noun-verb slug, e.g.
   * `'build-started'`). De-duplicated with a counter suffix when the same
   * noun-verb appears more than once in the workflow.
   */
  id: string;
  /** Fully-qualified CDEvent type string, e.g. `dev.cdevents.build.started.0.1.0`. */
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
   * The `<name>:<semver-range>` reference string when `origin` is
   * `'expression'`; absent for direct event items.
   */
  expressionRef?: string;
}

/**
 * Recursively deep-merges two plain objects. Values from `override` win over
 * `base` at every level; nested objects are merged rather than replaced.
 * Arrays and primitives in `override` fully replace the corresponding `base`
 * value.
 */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value !== null &&
      value !== undefined &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Resolves the `produces` list of a validated workflow into a flat, ordered
 * array of {@link ResolvedEvent} descriptors. Direct `event:` items are
 * converted one-to-one; `expression:` items are expanded into all CDEvents
 * declared by the matching bundle. Workflow defaults and per-event overrides
 * are merged throughout.
 *
 * @param workflow - A validated {@link WorkflowFile} from {@link validateWorkflow}.
 * @param registry - The expression registry from {@link loadExpressionRegistry},
 *   used to look up and expand expression bundles.
 * @returns An ordered array of resolved event descriptors suitable for passing
 *   to {@link buildManifest}.
 * @throws {Error} If an expression reference cannot be resolved in the registry.
 */
export function resolveProduces(
  workflow: WorkflowFile,
  registry: ExpressionRegistry,
): ResolvedEvent[] {
  const { defaults = {} as WorkflowDefaults, produces } = workflow.workflow;
  const events: ResolvedEvent[] = [];
  const idSeen = new Map<string, number>();

  /** Allocates a unique ID by appending a counter suffix when the base ID has been seen before. */
  const allocateId = (base: string): string => {
    const count = idSeen.get(base) ?? 0;
    idSeen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };

  for (const item of produces) {
    if (isEventItem(item)) {
      const tool = item.tool ?? defaults.tool ?? '';
      const source = item.source ?? defaults.source ?? '';
      const pipeline = item.pipeline ?? defaults.pipeline ?? '';
      const timeout_ms = item.timeout_ms ?? defaults.timeout_ms ?? 5000;
      const min_wait_ms = item.min_wait_ms ?? defaults.min_wait_ms ?? 100;
      const eventContent = item.subject?.content ?? item.content ?? {};
      const mergedContent = deepMerge(defaults.content ?? {}, eventContent);

      const nv = nounVerbFromType(item.event);
      const id = allocateId(nv.replace('.', '-'));

      events.push({
        id,
        type: item.event,
        tool,
        source,
        pipeline,
        timeout_ms,
        min_wait_ms,
        subject: {
          id: item.subject?.id ?? id,
          content: Object.keys(mergedContent).length > 0 ? mergedContent : undefined,
        },
        origin: 'event',
      });
    } else if (isExpressionItem(item)) {
      const bundle = registry.resolve(item.expression);

      for (const bundleEvent of bundle.produces) {
        const overrideKey = bundleEvent.id ?? nounVerbFromType(bundleEvent.event);
        const override = item.overrides?.[overrideKey] ?? {};

        const tool = override.tool ?? item.tool ?? defaults.tool ?? '';
        const source = override.source ?? item.source ?? defaults.source ?? '';
        const pipeline = item.pipeline ?? defaults.pipeline ?? '';
        const timeout_ms =
          override.timeout_ms ??
          item.timeout_ms ??
          bundleEvent.timeout_ms ??
          defaults.timeout_ms ??
          5000;
        const min_wait_ms =
          override.min_wait_ms ??
          item.min_wait_ms ??
          bundleEvent.min_wait_ms ??
          defaults.min_wait_ms ??
          100;

        const mergedContent = deepMerge(
          deepMerge(defaults.content ?? {}, bundleEvent.subject?.content ?? {}),
          override.content ?? {},
        );

        const baseId = bundleEvent.id ?? nounVerbFromType(bundleEvent.event).replace('.', '-');
        const id = allocateId(baseId);

        events.push({
          id,
          type: bundleEvent.event,
          tool,
          source,
          pipeline,
          timeout_ms,
          min_wait_ms,
          subject: {
            id: bundleEvent.subject?.id ?? id,
            content: Object.keys(mergedContent).length > 0 ? mergedContent : undefined,
          },
          origin: 'expression',
          expressionRef: item.expression,
        });
      }
    }
  }

  return events;
}
