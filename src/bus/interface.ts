/**
 * @module bus/interface
 * Defines the abstract {@link Bus} interface that all message bus adapters must
 * implement, and provides the {@link createBus} factory that selects the
 * correct adapter at runtime based on the config `type` discriminant.
 * Currently supported adapters: `'rabbitmq'` and `'kafka'`.
 */

import type {
  BusConfig,
  JunctionBoxBusConfig,
  KafkaBusConfig,
  RabbitMQBusConfig,
} from '../config/types.js';
import type { CDEventPayload } from '../manifest/types.js';

/** Diagnostic information returned by {@link Bus.inspect}. */
export interface BusInspectResult {
  /** The adapter type, e.g. `'rabbitmq'` or `'kafka'`. */
  type: string;
  /** Adapter-specific details such as queue depth or broker metadata. */
  details: Record<string, unknown>;
}

/** Options for the {@link Bus.purge} operation. */
export interface BusPurgeOptions {
  /** Specific queue name to purge (RabbitMQ). Uses the configured exchange when omitted. */
  queue?: string;
  /** Consumer group to reset (Kafka). Adapter-specific semantics apply. */
  group?: string;
}

/**
 * Common interface implemented by all Iron Monkey message bus adapters.
 * Callers obtain an instance via {@link createBus} and interact only through
 * this interface, keeping emission logic decoupled from the underlying broker.
 */
export interface Bus {
  /**
   * Establishes the connection to the broker. Must be called before
   * {@link emit}. Registers `SIGINT`/`SIGTERM` handlers to disconnect cleanly.
   *
   * @throws {Error} If the broker is unreachable or authentication fails.
   */
  connect(): Promise<void>;

  /**
   * Publishes a single CDEvent payload to the broker.
   *
   * @param eventType - Fully-qualified CDEvent type string used as a routing
   *   key or topic discriminant.
   * @param eventId - The CDEvents `context.id` UUID for logging and tracing.
   * @param payload - The full CDEvent payload object to serialise and send.
   * @throws {Error} If the adapter is not connected or publication fails.
   */
  emit(eventType: string, eventId: string, payload: CDEventPayload): Promise<void>;

  /**
   * Returns diagnostic information about the connected broker, such as queue
   * depth or broker cluster metadata.
   *
   * @throws {Error} If the adapter is not connected.
   */
  inspect(): Promise<BusInspectResult>;

  /**
   * Purges pending messages from a queue or consumer group, useful for
   * resetting state between test runs.
   *
   * @param opts - Optional target specifying which queue or group to purge.
   * @throws {Error} If the adapter is not connected.
   */
  purge(opts?: BusPurgeOptions): Promise<void>;

  /**
   * Closes the broker connection and releases all held resources. Safe to call
   * more than once; subsequent calls are no-ops.
   */
  disconnect(): Promise<void>;

  /**
   * Optional hook for buses that issue their own Sympraxis chain ID as part of
   * connection setup (e.g. Junction Box returns a `runId` from `/api/runs/register`).
   * When implemented and a non-empty string is returned, the runner uses this
   * value as the manifest's chainId in preference to Conduit or the local
   * fallback URN.
   *
   * @param workflowName - Workflow `name` from the YAML, available for adapters
   *   that need it for the activation request.
   * @returns The acquired chain ID, or `undefined` to defer to the standard
   *   chain-acquisition pipeline.
   */
  acquireChainId?(workflowName: string): Promise<string | undefined>;
}

/**
 * Factory function that instantiates the correct bus adapter for the given
 * `config.type`. Adapters are dynamically imported to keep unused broker
 * libraries out of the startup bundle.
 *
 * @param name - Logical bus name (from the config `buses` map key) used in
 *   log messages.
 * @param config - Typed bus configuration (RabbitMQ or Kafka).
 * @returns A constructed (but not yet connected) {@link Bus} instance.
 * @throws {Error} If `config.type` is not a recognised bus type.
 */
export async function createBus(name: string, config: BusConfig): Promise<Bus> {
  const busFactories = {
    rabbitmq: async () =>
      new (await import('./rabbit.js')).RabbitMQBus(name, config as RabbitMQBusConfig),
    kafka: async () => new (await import('./kafka.js')).KafkaBus(name, config as KafkaBusConfig),
    'junction-box': async () =>
      new (await import('./junctionbox.js')).JunctionBoxBus(name, config as JunctionBoxBusConfig),
  };
  if (busFactories[config.type]) {
    return busFactories[config.type]();
  }
  throw new Error(`Unknown bus type: '${(config as { type: string }).type}'`);
}
