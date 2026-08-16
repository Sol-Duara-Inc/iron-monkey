/**
 * @module execution/server
 * The inquiry HTTP surface (`docs/EXECUTION-INQUIRY.md` §2) — a small,
 * read-only JSON API Conduit's IM plugin calls when a TTL expires.
 *
 * Built on `node:http` with no framework: the surface is three routes, and
 * IM is consumed as a library (hints, catalog resolver, chain derivation are
 * all exported), so a web framework here would tax every consumer.
 *
 * **The idle timer is IM's linger.** A callback fires when a TTL expires,
 * which can be twenty minutes after the run finished, so a process that exits
 * with its last emission can never answer. The server therefore outlives runs
 * and shuts itself down only after a quiet window (default one hour, well past
 * any TTL in play). Two rules keep that honest:
 *
 * - a run still in flight VETOES shutdown outright — IM never exits mid-pitch
 *   because nobody happened to call;
 * - the timer is rescheduled on every request, and is `unref`'d so it never
 *   holds the process open by itself once the server is closed.
 *
 * Shutdown closes keep-alive sockets explicitly. `server.close()` alone waits
 * for held connections, which turns "shut down" into "shut down eventually".
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { getLogger } from '../logger/index.js';
import { projectExecution, deriveStatus } from './projection.js';
import type { ExecutionStore } from './store.js';

/** Default quiet window before the server retires itself. */
export const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60_000;

/** Options for {@link startInquiryServer}. */
export interface InquiryServerOptions {
  /** The record store the endpoint answers from. */
  store: ExecutionStore;
  /** Listen port; `0` picks an ephemeral one (tests, port-isolated benches). */
  port?: number;
  /**
   * Bind address. Defaults to loopback: this endpoint reports what your
   * pipelines are doing, so it does not listen on every interface unasked.
   */
  host?: string;
  /**
   * Operator-configured bearer credential. When unset, requests are accepted
   * unauthenticated (dev default, paired with the loopback bind).
   */
  token?: string;
  /** Quiet window before self-shutdown; `0` disables it entirely. */
  idleTimeoutMs?: number;
  /** Invoked after an idle shutdown, so a `serve` command can exit cleanly. */
  onIdleShutdown?: () => void;
}

/** A running inquiry server. */
export interface InquiryServer {
  /** The bound port (resolved, even when `0` was requested). */
  port: number;
  /** Base URL callers should be given. */
  url: string;
  /** Marks activity — run lifecycle transitions count, not just requests. */
  touch(): void;
  /** Stops listening and drops keep-alive sockets. */
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // A stale inquiry answer is worse than none: statuses change as the run
    // progresses, and the plugin may poll within one window.
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/**
 * Starts the inquiry server.
 *
 * @returns The listening server, with its resolved port.
 */
export async function startInquiryServer(opts: InquiryServerOptions): Promise<InquiryServer> {
  const logger = getLogger();
  const host = opts.host ?? '127.0.0.1';
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const { store } = opts;

  let idleTimer: NodeJS.Timeout | undefined;
  let closed = false;

  /** `true` while any run is still open — an unconditional veto on shutdown. */
  const runInFlight = (): boolean => store.list().some((r) => r.endedAt === undefined);

  const server: Server = createServer((req, res) => {
    handle(req, res);
    resetIdle();
  });

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const onBehalfOf = req.headers['x-conduit-on-behalf-of'];
    const url = new URL(req.url ?? '/', `http://${host}`);
    const route = url.pathname;

    // Logged verbatim so the bench can assert the runner identity arrived.
    // IM RECORDS this header; IM cannot verify it — it is inbound data, not
    // an authentication IM performs (docs/EXECUTION-INQUIRY.md §2).
    logger.info({ method: req.method, route, onBehalfOf }, 'inquiry request');

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: 'method not allowed', allowed: ['GET'] });
      return;
    }

    if (opts.token !== undefined && opts.token !== '') {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${opts.token}`) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
    }

    if (route === '/healthz') {
      json(res, 200, { ok: true, executions: store.size(), runInFlight: runInFlight() });
      return;
    }

    if (route === '/api/executions') {
      json(res, 200, {
        executions: store.list().map((r) => ({
          executionID: r.executionID,
          workflowId: r.workflowId,
          status: deriveStatus(r),
          startedAt: new Date(r.startedAt).toISOString(),
          endedAt: r.endedAt === undefined ? undefined : new Date(r.endedAt).toISOString(),
        })),
      });
      return;
    }

    const prefix = '/api/executions/';
    if (route.startsWith(prefix)) {
      const id = decodeURIComponent(route.slice(prefix.length));
      const found = store.get(id);
      if (found.outcome === 'found') {
        json(res, 200, projectExecution(found.record));
        return;
      }
      // 410 vs 404 is a real distinction for the caller: "I had this and let
      // it go" is a retention artifact, "I never had this" is a wrong id.
      if (found.outcome === 'gone') {
        json(res, 410, {
          error: 'execution record aged out of retention',
          executionID: id,
        });
        return;
      }
      json(res, 404, { error: 'unknown execution', executionID: id });
      return;
    }

    json(res, 404, { error: 'not found', route });
  }

  function resetIdle(): void {
    if (idleTimeoutMs <= 0 || closed) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdle, idleTimeoutMs);
    // Never let the idle timer itself be the reason the process is alive.
    idleTimer.unref();
  }

  function onIdle(): void {
    if (closed) return;
    if (runInFlight()) {
      // A pitch is still running; the quiet window restarts behind it.
      resetIdle();
      return;
    }
    logger.info(
      { idleMs: idleTimeoutMs, executions: store.size() },
      'inquiry server idle; shutting down',
    );
    void close().then(() => opts.onIdleShutdown?.());
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Keep-alive sockets would otherwise hold the close open until their
      // own timeout expires.
      server.closeIdleConnections();
      server.closeAllConnections();
    });
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (opts.port ?? 0);
  resetIdle();

  logger.info(
    { host, port, idleTimeoutMs, authenticated: Boolean(opts.token) },
    'inquiry server listening',
  );

  return {
    port,
    url: `http://${host}:${port}`,
    touch: resetIdle,
    close,
  };
}
