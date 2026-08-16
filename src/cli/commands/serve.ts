import { Command } from 'commander';
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
    const { createLogger, setLogger } = await import('../../logger/index.js');
    const { getExecutionStore } = await import('../../execution/store.js');
    const { startInquiryServer } = await import('../../execution/server.js');
    const { createControlPlane } = await import('../../execution/control.js');

    const logger = createLogger({
      level: (options.logLevel as LogLevel | undefined) ?? 'info',
      format: (options.logFormat as LogFormat | undefined) ?? 'json',
    });
    setLogger(logger);

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
      control: createControlPlane({
        config: options.config as string | undefined,
        bus: options.bus as string | undefined,
        workflowRoot: options.workflowRoot as string | undefined,
        logLevel: options.logLevel as string | undefined,
        logFormat: options.logFormat as string | undefined,
      }),
    });

    process.stdout.write(`iron-monkey daemon: ${server.url}\n`);
    logger.info({ url: server.url, workflowRoot: options.workflowRoot }, 'daemon ready');

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
