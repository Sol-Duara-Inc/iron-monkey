/**
 * @module execution/control
 * The daemon's control plane: starting runs on request.
 *
 * Lives here rather than in the CLI so both consumers share ONE
 * implementation — `iron-monkey serve` and the contract bench's callback
 * gate, which drives the same endpoint over HTTP to prove the breach →
 * callback → detail loop closes. A second copy in the bench would be a
 * harness that tests itself rather than the product.
 */

import path from 'path';
import { getLogger } from '../logger/index.js';
import type { RunOptions } from '../emitter/runner.js';
import type { WorkflowSource } from '../workflow/source.js';
import type { InquiryControlPlane, StartRunRequest, StartRunResult } from './server.js';

/** The run entry point the control plane drives. */
export type RunWorkflowFn = (source: WorkflowSource, options: RunOptions) => Promise<void>;

/** Defaults a triggered run inherits when its request does not name them. */
export interface ControlPlaneOptions {
  /** Config path applied when the request omits one. */
  config?: string;
  /** Bus name applied when the request omits one. */
  bus?: string;
  /**
   * When set, a triggered workflow path must resolve inside this directory.
   * A trigger names a file, so this is the containment for a daemon that is
   * not purely local; unset (the loopback default) allows any readable path.
   */
  workflowRoot?: string;
  /** Log level/format handed to triggered runs. */
  logLevel?: string;
  logFormat?: string;
  /**
   * The run entry point, injectable. Defaults to `runWorkflow`. Exposed
   * because a hard-coded import makes the containment check — a security
   * boundary — untestable without module mocking, and because an embedder
   * may drive a different runner.
   */
  runWorkflow?: RunWorkflowFn;
}

/**
 * Builds a control plane that starts real runs.
 *
 * The returned `startRun` resolves as soon as the execution is RECORDED, not
 * when the run finishes: a run takes minutes, and the caller needs the id
 * immediately so it can poll the live record. A run that dies before
 * recording anything (bad path, invalid workflow) rejects, so a failed
 * trigger is an answer rather than a hung request.
 */
export function createControlPlane(opts: ControlPlaneOptions = {}): InquiryControlPlane {
  const workflowRoot =
    opts.workflowRoot === undefined ? undefined : path.resolve(opts.workflowRoot);

  return {
    async startRun(request: StartRunRequest): Promise<StartRunResult> {
      const logger = getLogger();
      const { FileWorkflowSource } = await import('../workflow/source.js');
      const runWorkflow = opts.runWorkflow ?? (await import('../emitter/runner.js')).runWorkflow;

      const workflow = path.resolve(request.workflow);
      if (workflowRoot !== undefined && !workflow.startsWith(workflowRoot + path.sep)) {
        throw new Error(`workflow '${request.workflow}' is outside the configured workflow root`);
      }

      let announce: (r: StartRunResult) => void = () => {};
      const started = new Promise<StartRunResult>((resolve) => {
        announce = resolve;
      });

      const run = runWorkflow(new FileWorkflowSource(workflow), {
        config: request.config ?? opts.config,
        bus: request.bus ?? opts.bus,
        inject: request.inject,
        interval: request.interval,
        seed: request.seed,
        // Commander's `--no-conduit` sets `conduit: false`; the runner reads
        // that, so translate rather than inventing a second flag.
        conduit: request.noConduit === true ? false : undefined,
        logLevel: opts.logLevel,
        logFormat: opts.logFormat,
        onExecutionStarted: announce,
      });

      run.catch((err: unknown) => {
        logger.error(
          { workflow, err: (err as Error).message },
          'triggered run ended with an error',
        );
      });

      return Promise.race([
        started,
        run.then<StartRunResult>(() => {
          throw new Error('run finished without recording an execution');
        }),
      ]);
    },
  };
}
