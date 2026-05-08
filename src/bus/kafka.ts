import { Kafka, type Producer } from 'kafkajs';
import { getLogger } from '../logger/index.js';
import type { KafkaBusConfig } from '../config/types.js';
import type { CDEventPayload } from '../manifest/types.js';
import type { Bus, BusInspectResult, BusPurgeOptions } from './interface.js';

export class KafkaBus implements Bus {
  private name: string;
  private config: KafkaBusConfig;
  private kafka: Kafka | null = null;
  private producer: Producer | null = null;

  constructor(name: string, config: KafkaBusConfig) {
    this.name = name;
    this.config = config;
  }

  async connect(): Promise<void> {
    const logger = getLogger();
    logger.info({ bus: this.name, brokers: this.config.brokers }, 'connecting to Kafka');

    this.kafka = new Kafka({
      clientId: 'iron-monkey',
      brokers: this.config.brokers,
    });

    this.producer = this.kafka.producer();
    await this.producer.connect();

    process.on('SIGINT', () => this.disconnect());
    process.on('SIGTERM', () => this.disconnect());

    logger.info({ bus: this.name }, 'connected to Kafka');
  }

  async emit(eventType: string, eventId: string, payload: CDEventPayload): Promise<void> {
    if (!this.producer) throw new Error('Kafka not connected');

    const topic = this.config.topic ?? 'cdevents';
    await this.producer.send({
      topic,
      messages: [
        {
          key: eventId,
          value: JSON.stringify(payload),
          headers: { 'ce-type': eventType, 'content-type': 'application/json' },
        },
      ],
    });
  }

  async inspect(): Promise<BusInspectResult> {
    if (!this.kafka) throw new Error('Kafka not connected');

    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const topic = this.config.topic ?? 'cdevents';
      const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
      const topicMeta = metadata.topics.find((t) => t.name === topic);
      return {
        type: 'kafka',
        details: {
          topic,
          partitions: topicMeta?.partitions.length ?? 0,
        },
      };
    } finally {
      await admin.disconnect();
    }
  }

  async purge(opts?: BusPurgeOptions): Promise<void> {
    if (!this.kafka) throw new Error('Kafka not connected');

    const group = opts?.group;
    if (!group) {
      getLogger().warn(
        { bus: this.name },
        'Kafka purge resets consumer group offsets to latest. Provide --group <name>. Topic deletion is not supported.',
      );
      return;
    }

    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const topic = this.config.topic ?? 'cdevents';
      await admin.resetOffsets({ groupId: group, topic, earliest: false });
      getLogger().info({ bus: this.name, group, topic }, 'consumer group offsets reset to latest');
    } finally {
      await admin.disconnect();
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.producer?.disconnect();
    } catch {
      // ignore errors on disconnect
    }
    this.producer = null;
    this.kafka = null;
  }
}
