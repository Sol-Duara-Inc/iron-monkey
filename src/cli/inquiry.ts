/**
 * @module cli/inquiry
 * CLI glue for the expiry-inquiry server: reads the `--serve` family of flags,
 * starts the endpoint against the process-wide execution store, and holds the
 * process open until the server retires itself.
 *
 * Why the process must linger at all: Conduit calls back when a TTL expires,
 * which can be twenty minutes after the last event shipped. A CLI that exits
 * with its final emission can never answer, so `--serve` converts the run into
 * a run-then-answer lifecycle. The idle timer decides when that ends
 * (`docs/EXECUTION-INQUIRY.md` §1) — a run in flight always vetoes it.
 */

import { getExecutionStore } from '../execution/store.js';
import { startInquiryServer } from '../execution/server.js';
import { getLogger } from '../logger/index.js';
import type { InquiryServer } from '../execution/server.js';

/** The handle returned when `--serve` was requested. */
export interface InquiryHandle {
  /** The running server, or `undefined` when `--serve` was not passed. */
  server?: InquiryServer;
  /**
   * Resolves once the server has retired itself (idle) — awaited by the CLI
   * so the process stays alive to answer. Resolves immediately when no server
   * was started.
   */
  untilIdle(): Promise<void>;
}

/**
 * Starts the inquiry endpoint when `--serve` is present.
 *
 * @param options - Parsed commander options.
 * @returns A handle whose `untilIdle()` the command awaits before exiting.
 */
export async function serveInquiriesUntilIdle(
  options: Record<string, unknown>,
): Promise<InquiryHandle> {
  if (options.serve !== true) {
    return { untilIdle: () => Promise.resolve() };
  }

  const logger = getLogger();
  let resolveIdle: () => void = () => {};
  const idle = new Promise<void>((resolve) => {
    resolveIdle = resolve;
  });

  const server = await startInquiryServer({
    store: getExecutionStore(),
    port: options.inquiryPort as number | undefined,
    host: options.inquiryHost as string | undefined,
    token: options.inquiryToken as string | undefined,
    idleTimeoutMs: options.idleTimeout as number | undefined,
    onIdleShutdown: () => resolveIdle(),
  });

  // The URL goes to stdout, not just the log: an operator (or a bench) needs
  // it to configure the callback, and the log may be JSON on another stream.
  process.stdout.write(`inquiry endpoint: ${server.url}/api/executions/<executionID>\n`);
  logger.info({ url: server.url }, 'serving expiry inquiries');

  return {
    server,
    untilIdle: () => idle,
  };
}
