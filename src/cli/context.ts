/**
 * @module cli/context
 * The shared command preamble: logger creation + registration and config
 * loading with CLI overrides. Previously copy-pasted across validate,
 * dry-run, inspect, and purge. Imports stay dynamic so command startup keeps
 * the CLI's lazy-loading behavior.
 */

import type { IronMonkeyConfig } from '../config/types.js';
import type { createLogger } from '../logger/index.js';

/** What every command needs before doing its real work. */
export interface CommandContext {
  logger: ReturnType<typeof createLogger>;
  config: IronMonkeyConfig;
}

/**
 * Builds the logger (registered globally) and loads config with the standard
 * CLI overrides from the common flags.
 */
export async function createCommandContext(
  options: Record<string, unknown>,
): Promise<CommandContext> {
  const { createLogger, setLogger } = await import('../logger/index.js');
  const { loadConfig } = await import('../config/loader.js');

  const logger = createLogger({
    level: options.logLevel as 'info',
    format: options.logFormat as 'json',
  });
  setLogger(logger);

  const config = await loadConfig({
    configPath: options.config as string | undefined,
    cliOverrides: { busName: options.bus as string | undefined },
  });

  return { logger, config };
}
