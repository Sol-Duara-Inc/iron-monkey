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
