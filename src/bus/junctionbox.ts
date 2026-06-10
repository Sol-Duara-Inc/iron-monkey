/**
 * @module bus/junctionbox
 * Junction Box HTTP bus adapter for Iron Monkey. Implements the {@link Bus}
 * interface against Junction Box's REST API:
 *
 * - `GET  /health`           — preflight reachability check
 * - `POST /api/runs/register` — register a pipeline run, receive a `runId`
 *                               (used as the Sympraxis chainId); also arms
 *                               the workflow graph and starts the first-event
 *                               breach timer
 * - `POST /api/events`       — publish a single CDEvent payload (expects 202)
 * - `GET  /api/observatory`  — diagnostic: list active workflow runs
 *
 * This is the Iron Monkey counterpart to the `fire-sequence.zsh` reference
 * script that the project tests against. Pacing, payload synthesis, and
 * chain-link wiring stay in the manifest layer; the bus is responsible only
 * for transport and per-event publication.
 */

import { getLogger } from '../logger/index.js';
import { registerBusShutdown } from './shutdown.js';
import type { JunctionBoxBusConfig } from '../config/types.js';
import type { CDEventPayload } from '../manifest/types.js';
import type { Bus, BusInspectResult, BusPurgeOptions } from './interface.js';

/** Junction Box implementation of the {@link Bus} interface. */
export class JunctionBoxBus implements Bus {
  private name: string;
  private config: JunctionBoxBusConfig;
  private connected = false;
  private acquiredChainId: string | undefined;

  /**
   * @param name - Logical bus name used in log messages (matches the config map key).
   * @param config - Junction Box connection configuration including base URL,
   *   optional workflow ID for auto-launch, and optional headers.
   */
  constructor(name: string, config: JunctionBoxBusConfig) {
    this.name = name;
    this.config = config;
  }

  /**
   * Performs the Junction Box preflight: optional `GET /health`, then optional
   * `POST /api/runs/register` with the configured `workflow_id`. The returned
   * `runId` is stashed and exposed via {@link acquireChainId}.
   *
   * @throws {Error} If the health check fails or `/api/runs/register` returns
   *   no usable `runId`.
   */
  async connect(): Promise<void> {
    const logger = getLogger();
    const base = this.baseUrl();

    if (this.config.health_check !== false) {
      logger.info({ bus: this.name, url: `${base}/health` }, 'Junction Box health check');
      const res = await fetch(`${base}/health`, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      }).catch((err: Error) => {
        throw new Error(`Junction Box unreachable at ${base}: ${err.message}`);
      });
      if (!res.ok) {
        throw new Error(`Junction Box health check failed: HTTP ${res.status}`);
      }
    }

    if (this.config.workflow_id && this.config.launch !== false) {
      const registerUrl = `${base}/api/runs/register`;
      logger.info(
        { bus: this.name, url: registerUrl, workflowId: this.config.workflow_id },
        'activating workflow',
      );
      const res = await fetch(registerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers() },
        body: JSON.stringify({ workflowId: this.config.workflow_id }),
        signal: AbortSignal.timeout(10000),
      });
      const bodyText = await res.text();
      let body: { runId?: string; alreadyActive?: boolean; error?: string } = {};
      try {
        body = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        // tolerate non-JSON; surfaced via error path below
      }
      if (!res.ok && !body.runId) {
        throw new Error(
          `Junction Box /api/runs/register failed: HTTP ${res.status} ${bodyText.slice(0, 200)}`,
        );
      }
      if (!body.runId) {
        throw new Error(
          `Junction Box /api/runs/register returned no runId: ${bodyText.slice(0, 200)}`,
        );
      }
      this.acquiredChainId = body.runId;
      const reused = Boolean(body.alreadyActive || body.error);
      logger.info(
        { bus: this.name, chainId: body.runId, reused },
        reused ? 'workflow already active — reusing existing run' : 'workflow activated',
      );
    }

    this.connected = true;
    registerBusShutdown(() => this.disconnect());
  }

  /**
   * Returns the `runId` captured from `/api/runs/register` so the runner can use it
   * as the manifest chainId. Returns `undefined` when no launch was performed.
   */
  async acquireChainId(): Promise<string | undefined> {
    return this.acquiredChainId;
  }

  /**
   * POSTs a single CDEvent payload to `/api/events`. Treats any HTTP status
   * other than the configured `expected_status` (default 202) as a failure.
   */
  async emit(eventType: string, eventId: string, payload: CDEventPayload): Promise<void> {
    if (!this.connected) {
      throw new Error(`Junction Box bus '${this.name}' is not connected`);
    }
    const logger = getLogger();
    const expected = this.config.expected_status ?? 202;
    const path = this.config.events_path ?? '/api/events';
    const url = `${this.baseUrl()}${path}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers() },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const bodyText = await res.text();
    if (res.status !== expected) {
      logger.warn(
        {
          bus: this.name,
          eventId,
          eventType,
          status: res.status,
          body: bodyText.slice(0, 200),
        },
        'Junction Box returned unexpected status',
      );
      throw new Error(
        `Junction Box ${path} returned HTTP ${res.status} (expected ${expected}): ${bodyText.slice(0, 200)}`,
      );
    }
    logger.debug({ bus: this.name, eventId, eventType, status: res.status }, 'event POSTed');
  }

  /** Calls `GET /api/observatory` and returns the parsed body for diagnostics. */
  async inspect(): Promise<BusInspectResult> {
    const url = `${this.baseUrl()}/api/observatory`;
    const res = await fetch(url, { headers: this.headers() });
    const bodyText = await res.text();
    let parsed: unknown = bodyText;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // leave as raw text
    }
    return {
      type: 'junction-box',
      details: {
        url,
        status: res.status,
        observatory: parsed,
      },
    };
  }

  /**
   * Junction Box does not expose a native purge primitive over the documented
   * REST API, so this is a no-op that logs a warning. Reset the workflow run
   * via Junction Box's own admin tooling if you need a clean slate.
   */
  async purge(_opts?: BusPurgeOptions): Promise<void> {
    getLogger().warn(
      { bus: this.name },
      'purge() not supported for junction-box bus; reset via Junction Box tooling',
    );
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  private baseUrl(): string {
    return this.config.url.replace(/\/$/, '');
  }

  private headers(): Record<string, string> {
    return { ...(this.config.headers ?? {}) };
  }
}
