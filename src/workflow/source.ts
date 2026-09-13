/**
 * @module workflow/source
 * Abstract strategy for supplying a workflow definition to Iron Monkey's
 * runner. Replaces the previous filesystem-path-only API with a polymorphic
 * source object so callers control where the workflow definition comes from.
 *
 * Built-in implementations:
 *  - {@link FileWorkflowSource} — reads from the local filesystem (CLI path).
 *
 * Third-party callers (e.g. Junction Box Playground) implement
 * {@link WorkflowSource} to supply workflow definitions from other stores
 * (Redis, databases, remote APIs) without Iron Monkey ever touching a file.
 */

import { validateWorkflow } from './parser.js';
import { isCatalogRef, parseCatalogRef } from '../catalog/ref.js';
import type { WorkflowFile } from './types.js';

/**
 * A workflow definition as consumed by the Iron Monkey runner.
 * Alias for {@link WorkflowFile} — the parsed and validated top-level
 * workflow structure.
 */
export type WorkflowDefinition = WorkflowFile;

/**
 * Strategy interface for supplying a workflow definition to Iron Monkey.
 * Implement this class to load workflow definitions from any source —
 * filesystem, Redis, a remote API, or an in-memory object.
 *
 * @example
 * class InMemoryWorkflowSource extends WorkflowSource {
 *   constructor(private readonly def: WorkflowDefinition) { super(); }
 *   get name() { return this.def.workflow.name; }
 *   async getWorkflow() { return this.def; }
 * }
 */
export abstract class WorkflowSource {
  /**
   * Human-readable name for this workflow. Used in logs, run labels, and
   * per-workflow result records returned by {@link runWorkflows}.
   */
  abstract get name(): string;

  /**
   * Returns the parsed, validated workflow definition. Called by the runner
   * immediately before manifest construction.
   *
   * @throws {Error} If the workflow definition cannot be retrieved or fails
   *   validation.
   */
  abstract getWorkflow(): Promise<WorkflowDefinition>;
}

/**
 * Reads a workflow definition from the local filesystem. The supplied `path`
 * is passed to {@link validateWorkflow}, which reads, YAML-parses, and
 * schema-validates the file.
 *
 * This is the implementation used by the Iron Monkey CLI — it wraps the
 * existing filesystem-path argument so the runner's public signature is
 * uniform across all callers.
 */
export class FileWorkflowSource extends WorkflowSource {
  /**
   * @param path - Absolute or relative filesystem path to the workflow YAML.
   */
  constructor(private readonly path: string) {
    super();
  }

  /**
   * Basename of the workflow path, used as the run label in logs and results.
   * e.g. `'/workflows/my-pipeline.yaml'` → `'my-pipeline.yaml'`.
   */
  get name(): string {
    return this.path.split('/').pop() ?? this.path;
  }

  /**
   * Reads and validates the workflow YAML file at the configured path.
   *
   * @throws {Error} If the file cannot be read or fails schema validation.
   */
  async getWorkflow(): Promise<WorkflowDefinition> {
    return validateWorkflow(this.path);
  }
}

/**
 * Reads a workflow from the catalog by its declared id.
 *
 * The lookup is deferred to {@link getWorkflow} on purpose: constructing a
 * source must never touch the catalog, so a run that only hands in paths is
 * unaffected by a catalog that is missing, empty, or broken.
 */
export class CatalogWorkflowSource extends WorkflowSource {
  constructor(
    private readonly id: string,
    private readonly catalogDir: string,
  ) {
    super();
  }

  /** The catalog id — what the operator typed, and what logs should show. */
  get name(): string {
    return `catalog:${this.id}`;
  }

  async getWorkflow(): Promise<WorkflowDefinition> {
    const { loadCatalog } = await import('../catalog/store.js');
    const file = loadCatalog(this.catalogDir).resolve('workflow', this.id);
    const workflow = await validateWorkflow(file);
    // The catalog is keyed on the identity the document declares, so this can
    // only fire if the file changed between indexing and reading.
    if (workflow.workflow.id !== this.id) {
      throw new Error(
        `catalog entry ${file} declares workflow id '${workflow.workflow.id}', ` +
          `not '${this.id}'`,
      );
    }
    return workflow;
  }
}

/**
 * Turns one reference into a source: the single place where "what does this
 * string mean" is decided.
 *
 * A `catalog:` token is a catalog id and is never stat'd as a path; anything
 * else is a path and is never retried as a catalog id. See `catalog/ref.ts`
 * for why the test is an exact literal rather than a scheme pattern.
 */
export function resolveWorkflowSource(ref: string, catalogDir: string): WorkflowSource {
  if (!isCatalogRef(ref)) return new FileWorkflowSource(ref);
  const parsed = parseCatalogRef(ref);
  if (parsed.kind !== 'workflow') {
    throw new Error(
      `'${ref}' names an expression, not a workflow. ` +
        `A workflow reference is 'catalog:<workflow-id>' with no slashes.`,
    );
  }
  return new CatalogWorkflowSource(parsed.id, catalogDir);
}
