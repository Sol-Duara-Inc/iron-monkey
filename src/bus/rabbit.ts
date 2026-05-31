/**
 * @module bus/rabbit
 * RabbitMQ bus adapter for Iron Monkey. Implements the {@link Bus} interface
 * using `amqplib`, publishing CDEvent payloads as persistent JSON messages on
 * a durable topic exchange. Credentials in the connection URL are sanitised in
 * log output. Routing keys are derived from the event type via a configurable
 * template.
 */

import amqp from 'amqplib';
import { getLogger } from '../logger/index.js';
import { registerBusShutdown } from './shutdown.js';
import type { RabbitMQBusConfig } from '../config/types.js';
import type { CDEventPayload } from '../manifest/types.js';
import type { Bus, BusInspectResult, BusPurgeOptions } from './interface.js';

/**
 * RabbitMQ implementation of the {@link Bus} interface. Maintains a single
 * AMQP connection and channel. The connection is automatically cleaned up on
 * `SIGINT` and `SIGTERM` signals.
 */
export class RabbitMQBus implements Bus {
  private name: string;
  private config: RabbitMQBusConfig;
  private rawConnection: Awaited<ReturnType<typeof amqp.connect>> | null = null;
  private channel: amqp.Channel | null = null;

  /**
   * @param name - Logical bus name used in log messages (matches the config map key).
   * @param config - RabbitMQ connection configuration including URL, optional
   *   auth credentials, exchange name, and routing key template.
   */
  constructor(name: string, config: RabbitMQBusConfig) {
    this.name = name;
    this.config = config;
  }

  /**
   * Opens the AMQP connection and creates a channel. Registers process-level
   * `SIGINT`/`SIGTERM` handlers to call {@link disconnect} before exit.
   *
   * @throws {Error} If the broker is unreachable or the connection is refused.
   */
  async connect(): Promise<void> {
    const logger = getLogger();
    const url = this.buildUrl();
    logger.info({ bus: this.name, url: this.sanitizeUrl(url) }, 'connecting to RabbitMQ');
    this.rawConnection = await amqp.connect(url);
    this.channel = await this.rawConnection.createChannel();

    this.rawConnection.on('close', () => {
      logger.warn({ bus: this.name }, 'RabbitMQ connection closed');
    });

    registerBusShutdown(() => this.disconnect());

    logger.info({ bus: this.name }, 'connected to RabbitMQ');
  }

  /**
   * Asserts a durable topic exchange and publishes a CDEvent payload as a
   * persistent JSON message. The routing key is derived from `eventType` using
   * the configured `routing_key_template`.
   *
   * @param eventType - CDEvent type string used to compute the routing key.
   * @param _eventId - Unused by this adapter (present for interface compatibility).
   * @param payload - CDEvent payload serialised as JSON.
   * @throws {Error} If not connected.
   */
  async emit(eventType: string, _eventId: string, payload: CDEventPayload): Promise<void> {
    if (!this.channel) throw new Error('RabbitMQ not connected');

    const exchange = this.config.exchange ?? 'cdevents';
    const routingKey = this.resolveRoutingKey(eventType);
    const body = Buffer.from(JSON.stringify(payload));

    await this.channel.assertExchange(exchange, 'topic', { durable: true });
    this.channel.publish(exchange, routingKey, body, {
      contentType: 'application/json',
      persistent: true,
    });
  }

  /**
   * Checks queue statistics on the configured exchange. Falls back to a
   * descriptive note when the exchange is not directly inspectable as a queue.
   *
   * @throws {Error} If not connected.
   */
  async inspect(): Promise<BusInspectResult> {
    if (!this.channel) throw new Error('RabbitMQ not connected');

    const exchange = this.config.exchange ?? 'cdevents';
    try {
      const q = await this.channel.checkQueue(exchange);
      return {
        type: 'rabbitmq',
        details: {
          queue: exchange,
          messageCount: q.messageCount,
          consumerCount: q.consumerCount,
        },
      };
    } catch {
      return {
        type: 'rabbitmq',
        details: { exchange, note: 'queue not found or not directly inspectable' },
      };
    }
  }

  /**
   * Purges all pending messages from the specified queue (or the configured
   * exchange name when no queue is specified). Useful for resetting broker
   * state between test runs.
   *
   * @param opts - Optional override for the target queue name.
   * @throws {Error} If not connected.
   */
  async purge(opts?: BusPurgeOptions): Promise<void> {
    if (!this.channel) throw new Error('RabbitMQ not connected');

    const queueName = opts?.queue ?? this.config.exchange ?? 'cdevents';
    await this.channel.purgeQueue(queueName);
    getLogger().info({ bus: this.name, queue: queueName }, 'queue purged');
  }

  /**
   * Closes the AMQP channel and connection. Errors during teardown are
   * swallowed so disconnect is always safe to call, including from signal
   * handlers.
   */
  async disconnect(): Promise<void> {
    try {
      await this.channel?.close();
      await this.rawConnection?.close();
    } catch {
      // ignore errors on disconnect
    }
    this.channel = null;
    this.rawConnection = null;
  }

  /**
   * Builds the full AMQP connection URL, injecting `auth` credentials into the
   * URL if they are provided separately in the config.
   */
  private buildUrl(): string {
    const auth = this.config.auth;
    if (auth) {
      const u = new URL(this.config.url);
      u.username = auth.username;
      u.password = auth.password;
      return u.toString();
    }
    return this.config.url;
  }

  /**
   * Returns a copy of the URL with the password replaced by `'***'` for safe
   * inclusion in log output.
   */
  private sanitizeUrl(url: string): string {
    try {
      const u = new URL(url);
      u.password = '***';
      return u.toString();
    } catch {
      return url;
    }
  }

  /**
   * Substitutes the `{eventType}` placeholder in the configured routing key
   * template with the actual CDEvent type string.
   *
   * @param eventType - The CDEvent type string to embed in the routing key.
   * @returns The resolved routing key string.
   */
  private resolveRoutingKey(eventType: string): string {
    const template = this.config.routing_key_template ?? '{eventType}';
    return template.replace('{eventType}', eventType);
  }
}
