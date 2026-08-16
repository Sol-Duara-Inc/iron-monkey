/**
 * @module execution/server
 * The inquiry HTTP surface (`docs/EXECUTION-INQUIRY.md` §2) and, when a
 * control plane is supplied, the daemon surface that lets an operator — or an
 * agent driving the integration — start runs and simulate an unreachable
 * producer.
 *
 * Built on `node:http` with no framework: the surface is a handful of routes,
 * and IM is consumed as a library (hints, catalog resolver, chain derivation
 * are all exported), so a web framework here would tax every consumer.
 *
 * **Two modes, one server.** `run --serve` passes no `control`, so the surface
 * is strictly read-only — a pitch answers inquiries about itself and nothing
 * more. `iron-monkey serve` passes a control plane, which is the whole point
 * of the daemon: the callback path cannot be tested end to end unless the
 * tester can start runs, withhold events, and take the endpoint away on
 * demand.
 *
 * **The idle timer is IM's linger.** A callback fires when a TTL expires,
 * which can be twenty minutes after the run finished, so a process that exits
 * with its last emission can never answer. Two rules keep that honest: a run
 * still in flight VETOES shutdown outright, and the timer is `unref`'d so it
 * never holds the process open by itself. Shutdown closes keep-alive sockets
 * explicitly — `server.close()` alone waits for held connections, which turns
 * "shut down" into "shut down eventually".
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { getLogger } from '../logger/index.js';
import { projectExecution, deriveStatus } from './projection.js';
import type { ExecutionStore } from './store.js';

/** Default quiet window before the server retires itself. */
export const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60_000;

/** Largest control-plane request body accepted. */
const MAX_BODY_BYTES = 64 * 1024;

/** A run the control plane was asked to start. */
export interface StartRunRequest {
  /** Path to the workflow YAML. */
  workflow: string;
  /** Path to an Iron Monkey config file. */
  config?: string;
  /** Bus name to emit on. */
  bus?: string;
  /** Injection specs, e.g. `['missing:artifact-signed', 'abort:build-finished']`. */
  inject?: string[];
  /** Exact per-event interval in ms. */
  interval?: number;
  /** Seed for deterministic ids and timing. */
  seed?: number;
  /** Skip Conduit registration and mint a local chain id. */
  noConduit?: boolean;
}

/** What the control plane reports once a triggered run has begun. */
export interface StartRunResult {
  executionID: string;
  workflowId: string;
}

/** The daemon's control plane. Absent ⇒ the server is read-only. */
export interface InquiryControlPlane {
  /**
   * Starts a run and resolves as soon as its execution is RECORDED — not when
   * it finishes. Rejects when the run could not be started at all.
   */
  startRun(request: StartRunRequest): Promise<StartRunResult>;
}

/** How a darkened endpoint fails: a refusal, or silence. */
export type DarkMode = '5xx' | 'hang';

/** Options for {@link startInquiryServer}. */
export interface InquiryServerOptions {
  /** The record store the endpoint answers from. */
  store: ExecutionStore;
  /** Listen port; `0` picks an ephemeral one (tests, port-isolated benches). */
  port?: number;
  /**
   * Bind address. Defaults to loopback: this endpoint reports what your
   * pipelines are doing and — with a control plane — starts them, so it does
   * not listen on every interface unasked.
   */
  host?: string;
  /**
   * Operator-configured bearer credential. When unset, requests are accepted
   * unauthenticated (dev default, paired with the loopback bind).
   */
  token?: string;
  /** Quiet window before self-shutdown; `0` disables it entirely. */
  idleTimeoutMs?: number;
  /** Invoked after an idle shutdown, so a command can exit cleanly. */
  onIdleShutdown?: () => void;
  /** Supplying this enables the daemon's control plane. */
  control?: InquiryControlPlane;
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

/** Reads a JSON body, capped, rejecting anything oversized or unparseable. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
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
  const { store, control } = opts;

  let idleTimer: NodeJS.Timeout | undefined;
  let closed = false;
  /** Epoch ms until which inquiries are darkened; 0 = lit. */
  let darkUntil = 0;
  let darkMode: DarkMode = '5xx';

  const isDark = (): boolean => darkUntil > Date.now();

  /** `true` while any run is still open — an unconditional veto on shutdown. */
  const runInFlight = (): boolean => store.list().some((r) => r.endedAt === undefined);

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      logger.error({ err: (err as Error).message }, 'inquiry request failed');
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    });
    resetIdle();
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const onBehalfOf = req.headers['x-conduit-on-behalf-of'];
    const url = new URL(req.url ?? '/', `http://${host}`);
    const route = url.pathname;
    const method = req.method ?? 'GET';

    // Logged verbatim so the bench can assert the runner identity arrived.
    // IM RECORDS this header; IM cannot verify it — it is inbound data, not
    // an authentication IM performs (docs/EXECUTION-INQUIRY.md §2).
    logger.info({ method, route, onBehalfOf }, 'inquiry request');

    if (opts.token !== undefined && opts.token !== '') {
      if (req.headers.authorization !== `Bearer ${opts.token}`) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
    }

    // ── control plane (daemon only) ─────────────────────────────────────────
    if (route.startsWith('/api/control/')) {
      if (!control) {
        json(res, 404, { error: 'control plane not enabled; start with `iron-monkey serve`' });
        return;
      }
      if (route === '/api/control/go-dark') {
        if (method === 'GET') {
          json(res, 200, {
            dark: isDark(),
            mode: darkMode,
            until: darkUntil === 0 ? undefined : new Date(darkUntil).toISOString(),
          });
          return;
        }
        if (method === 'DELETE') {
          darkUntil = 0;
          logger.warn({}, 'inquiries restored');
          json(res, 200, { dark: false });
          return;
        }
        if (method === 'POST') {
          const body = await readJson(req);
          const seconds = typeof body.seconds === 'number' ? body.seconds : 60;
          darkMode = body.mode === 'hang' ? 'hang' : '5xx';
          darkUntil = Date.now() + seconds * 1000;
          logger.warn({ mode: darkMode, seconds }, 'inquiries going dark');
          json(res, 200, {
            dark: true,
            mode: darkMode,
            until: new Date(darkUntil).toISOString(),
          });
          return;
        }
      }
      json(res, 404, { error: 'unknown control route', route });
      return;
    }

    // /healthz and the control plane stay reachable while dark ON PURPOSE:
    // the driver that darkened the endpoint has to be able to see it and turn
    // it back on. Only the inquiry routes — the ones Conduit calls — go away.
    if (route === '/healthz') {
      json(res, 200, {
        ok: true,
        executions: store.size(),
        runInFlight: runInFlight(),
        dark: isDark(),
        control: Boolean(control),
      });
      return;
    }

    if (route.startsWith('/api/executions') && isDark()) {
      if (darkMode === 'hang') {
        // Deliberately no response: the plugin's "endpoint hangs" row, which
        // exercises its ≤5-minute retry budget rather than a fast failure.
        logger.warn({ route }, 'dark: hanging the request');
        return;
      }
      json(res, 503, { error: 'producer unavailable (simulated)' });
      return;
    }

    // ── starting a run (daemon only) ────────────────────────────────────────
    if (route === '/api/executions' && method === 'POST') {
      if (!control) {
        json(res, 405, {
          error: 'this server is read-only; start with `iron-monkey serve` to trigger runs',
        });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
        return;
      }
      if (typeof body.workflow !== 'string' || body.workflow === '') {
        json(res, 400, { error: "field 'workflow' (path to a workflow YAML) is required" });
        return;
      }
      try {
        const started = await control.startRun({
          workflow: body.workflow,
          config: typeof body.config === 'string' ? body.config : undefined,
          bus: typeof body.bus === 'string' ? body.bus : undefined,
          inject: Array.isArray(body.inject) ? (body.inject as string[]) : undefined,
          interval: typeof body.interval === 'number' ? body.interval : undefined,
          seed: typeof body.seed === 'number' ? body.seed : undefined,
          noConduit: body.noConduit === true,
        });
        // 202: the run is under way, not finished. Poll the execution for its
        // progress — that is the whole point of the record being live.
        json(res, 202, { ...started, status: 'accepted' });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      json(res, 405, { error: 'method not allowed', allowed: ['GET'] });
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
        json(res, 410, { error: 'execution record aged out of retention', executionID: id });
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
      // Keep-alive sockets — and any request being deliberately hung — would
      // otherwise hold the close open until their own timeouts expire.
      server.closeIdleConnections();
      server.closeAllConnections();
    });
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (opts.port ?? 0);
  resetIdle();

  logger.info(
    { host, port, idleTimeoutMs, authenticated: Boolean(opts.token), control: Boolean(control) },
    'inquiry server listening',
  );

  return { port, url: `http://${host}:${port}`, touch: resetIdle, close };
}
