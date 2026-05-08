/**
 * @module logger
 * Thin wrapper around Pino that provides a process-global logger singleton.
 * The singleton allows deeply nested modules (e.g. bus adapters, the manifest
 * builder) to access a consistent logger without threading it through every
 * call stack. The logger is initialised with `info`-level JSON output by
 * default and can be replaced via {@link setLogger} before a run begins.
 */

import pino from 'pino';

/** Supported Pino log levels for Iron Monkey configuration. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Supported output formats: structured JSON or human-friendly pretty-print. */
export type LogFormat = 'json' | 'text';

/** Options for constructing a new logger instance. */
export interface LoggerOptions {
  /** Minimum log level to emit (default: `'info'`). */
  level?: LogLevel;
  /**
   * Output format. `'json'` writes newline-delimited JSON via Pino defaults;
   * `'text'` uses `pino-pretty` with colourised, timestamp-formatted output.
   */
  format?: LogFormat;
}

/**
 * Creates and returns a new Pino logger instance configured according to
 * `options`. The returned logger is **not** automatically installed as the
 * global singleton; call {@link setLogger} to replace the singleton.
 *
 * @param options - Logger configuration (level and format).
 * @returns A Pino logger instance.
 */
export function createLogger(options: LoggerOptions = {}) {
  const level = options.level ?? 'info';
  const format = options.format ?? 'json';

  if (format === 'text') {
    return pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  return pino({ level });
}

/** Inferred return type of {@link createLogger}, representing a Pino logger. */
export type Logger = ReturnType<typeof createLogger>;

let _logger: Logger = createLogger();

/**
 * Replaces the process-global logger singleton. Call this once at startup
 * (e.g. in {@link runWorkflow}) before any module logs its first message.
 *
 * @param logger - A Pino logger instance created by {@link createLogger}.
 */
export function setLogger(logger: Logger) {
  _logger = logger;
}

/**
 * Returns the current process-global logger singleton. All Iron Monkey modules
 * call this rather than maintaining their own logger references, so a single
 * {@link setLogger} call at startup propagates the chosen level and format
 * everywhere.
 *
 * @returns The active {@link Logger} instance.
 */
export function getLogger(): Logger {
  return _logger;
}
