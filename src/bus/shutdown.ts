/**
 * @module bus/shutdown
 * Shared process-signal teardown for bus adapters. Every adapter must
 * disconnect cleanly on `SIGINT` / `SIGTERM`; this registers both signals to a
 * single disconnect callback so the (previously copy-pasted) handler lives in
 * one place.
 */

/**
 * Registers `SIGINT` and `SIGTERM` handlers that invoke `disconnect` for clean
 * shutdown. The callback's returned promise (if any) is fire-and-forget — signal
 * handlers cannot await — matching the adapters' prior behaviour.
 *
 * @param disconnect - The adapter's `disconnect` method (bind or arrow to keep `this`).
 */
export function registerBusShutdown(disconnect: () => Promise<void> | void): void {
  const handler = (): void => void disconnect();
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}
