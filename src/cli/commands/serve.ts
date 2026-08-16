import { Command } from 'commander';
import type { StartRunRequest, StartRunResult } from '../../execution/server.js';
import type { LogLevel, LogFormat } from '../../logger/index.js';

/**
 * `iron-monkey serve` — the daemon.
 *
 * The inquiry endpoint alone is not testable: proving Conduit's expiry
 * callback works means starting a run, withholding an event so a TTL really
 * breaches, asking IM what happened, and taking the endpoint away to prove
 * the no-answer path. All four have to be drivable from outside the process,
 * which is why the daemon carries a control plane and `run --serve` does not.
 *
 * Routes (see `docs/EXECUTION-INQUIRY.md`):
 *
 *   POST   /api/executions          start a run → 202 { executionID }
 *   GET    /api/executions          list the retained records
 *   GET    /api/executions/{id}     the inquiry answer
 *   POST   /api/control/go-dark     stop answering inquiries (5xx or hang)
 *   DELETE /api/control/go-dark     answer again
 *   GET    /healthz                 always answers, even while dark
 */
export function serveCommand(): Command {
  const cmd = new Command('serve')
    .description('run the daemon: trigger runs and answer Conduit expiry inquiries')
    .option('--port <port>', 'listen port (default 8137; 0 picks a free one)', parseInt)
    .option('--host <host>', 'bind address (default 127.0.0.1)')
    .option('--token <token>', 'require this bearer credential on every request')
    .option('--config <path>', 'default Iron Monkey config for triggered runs')
    .option('--bus <name>', 'default bus for triggered runs')
    .option('--workflow-root <dir>', 'restrict triggered workflows to paths inside this directory')
    .option(
      '--idle-timeout <ms>',
      'quiet window before the daemon retires itself; 0 never retires (default 3600000)',
      parseInt,
    )
    .option('--log-level <level>', 'error | warn | info | debug', 'info')
    .option('--log-format <fmt>', 'json | text', 'json');

  cmd.action(async (options: Record<string, unknown>) => {
    const path = await import('path');
    const { createLogger, setLogger } = await import('../../logger/index.js');
    const { getExecutionStore } = await import('../../execution/store.js');
    const { startInquiryServer } = await import('../../execution/server.js');
    const { runWorkflow } = await import('../../emitter/runner.js');
    const { FileWorkflowSource } = await import('../../workflow/source.js');
    const logger = createLogger({
      level: (options.logLevel as LogLevel | undefined) ?? 'info',
      format: (options.logFormat as LogFormat | undefined) ?? 'json',
    });
    setLogger(logger);

    const workflowRoot =
      typeof options.workflowRoot === 'string' ? path.resolve(options.workflowRoot) : undefined;

    let resolveIdle: () => void = () => {};
    const idle = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });

    const server = await startInquiryServer({
      store: getExecutionStore(),
      port: (options.port as number | undefined) ?? 8137,
      host: options.host as string | undefined,
      token: options.token as string | undefined,
      idleTimeoutMs: options.idleTimeout as number | undefined,
      onIdleShutdown: () => resolveIdle(),
      control: {
        async startRun(request: StartRunRequest): Promise<StartRunResult> {
          // Containment: a triggered run names a file path, so when a root is
          // configured the resolved path must stay inside it. Unset (the
          // loopback dev default) means any path the process can read.
          const workflow = path.resolve(request.workflow);
          if (workflowRoot !== undefined && !workflow.startsWith(workflowRoot + path.sep)) {
            throw new Error(`workflow '${request.workflow}' is outside --workflow-root`);
          }

          // Resolve as soon as the execution is RECORDED. A run can take
          // minutes; the caller needs its id now, so it can poll the record
          // while the pipeline is still going.
          let announce: (r: StartRunResult) => void = () => {};
          const started = new Promise<StartRunResult>((resolve) => {
            announce = resolve;
          });

          const run = runWorkflow(new FileWorkflowSource(workflow), {
            config: (request.config ?? options.config) as string | undefined,
            bus: (request.bus ?? options.bus) as string | undefined,
            inject: request.inject,
            interval: request.interval,
            seed: request.seed,
            // Commander's `--no-conduit` sets `conduit: false`; the runner
            // reads that, so translate rather than inventing a second flag.
            conduit: request.noConduit === true ? false : undefined,
            logLevel: options.logLevel as string | undefined,
            logFormat: options.logFormat as string | undefined,
            onExecutionStarted: announce,
          });

          // A run that fails BEFORE recording an execution (bad path, invalid
          // workflow) must surface as a failed trigger rather than hanging
          // this request forever.
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
      },
    });

    process.stdout.write(`iron-monkey daemon: ${server.url}\n`);
    logger.info({ url: server.url, workflowRoot }, 'daemon ready');

    const stop = (signal: string): void => {
      logger.info({ signal }, 'daemon stopping');
      void server.close().then(() => resolveIdle());
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));

    await idle;
  });

  return cmd;
}
