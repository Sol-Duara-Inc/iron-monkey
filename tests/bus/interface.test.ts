import { describe, it, expect } from 'vitest';
import { createBus } from '../../src/bus/interface.js';
import { RabbitMQBus } from '../../src/bus/rabbit.js';
import { KafkaBus } from '../../src/bus/kafka.js';
import { JunctionBoxBus } from '../../src/bus/junctionbox.js';
import type { BusConfig } from '../../src/config/types.js';

describe('createBus', () => {
  it('instantiates a RabbitMQBus for type: "rabbitmq"', async () => {
    const bus = await createBus('rabbit-default', {
      type: 'rabbitmq',
      url: 'amqp://localhost:5672',
    });
    expect(bus).toBeInstanceOf(RabbitMQBus);
  });

  it('instantiates a KafkaBus for type: "kafka"', async () => {
    const bus = await createBus('kafka-default', {
      type: 'kafka',
      brokers: ['localhost:9092'],
    });
    expect(bus).toBeInstanceOf(KafkaBus);
  });

  it('instantiates a JunctionBoxBus for type: "junction-box"', async () => {
    const bus = await createBus('jb-default', {
      type: 'junction-box',
      url: 'http://localhost:3000',
    });
    expect(bus).toBeInstanceOf(JunctionBoxBus);
  });

  it('returns a fresh instance per call', async () => {
    const config: BusConfig = { type: 'rabbitmq', url: 'amqp://localhost:5672' };
    const a = await createBus('a', config);
    const b = await createBus('b', config);
    expect(a).not.toBe(b);
  });

  it('throws a descriptive error for an unrecognised bus type', async () => {
    // The type assertion bypasses the compile-time discriminant so the
    // runtime guard in createBus has something to reject.
    const bogus = { type: 'sqs', url: 'sqs://x' } as unknown as BusConfig;
    await expect(createBus('weird', bogus)).rejects.toThrow(/Unknown bus type.*sqs/);
  });

  it('does not attempt to connect — returned bus is unconnected', async () => {
    // Sanity: createBus should be a pure factory; the only way to know it
    // didn't open a socket is that emit() rejects with the not-connected
    // guard before any network I/O happens.
    const bus = await createBus('jb', {
      type: 'junction-box',
      url: 'http://localhost:3000',
    });
    await expect(
      bus.emit('dev.cdevents.build.started.0.3.0', 'evt-1', {
        context: {
          specversion: '0.6.0-draft',
          id: 'evt-1',
          source: 'https://example.com/',
          type: 'dev.cdevents.build.started.0.3.0',
          timestamp: '2026-05-08T00:00:00.000Z',
        },
        subject: { id: 'sub-1', content: {} },
      }),
    ).rejects.toThrow(/not connected/);
  });
});
