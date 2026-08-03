import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RabbitMQBus } from '../../src/bus/rabbit.js';
import type { RabbitMQBusConfig } from '../../src/config/types.js';

// ── amqplib mock ──────────────────────────────────────────────────────────────

const { mockChannel, mockConnection } = vi.hoisted(() => {
  const mockChannel = {
    assertExchange: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockReturnValue(true),
    checkQueue: vi.fn().mockResolvedValue({ messageCount: 5, consumerCount: 1 }),
    purgeQueue: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mockConnection = {
    createChannel: vi.fn().mockResolvedValue(mockChannel),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { mockChannel, mockConnection };
});

vi.mock('amqplib', () => ({
  default: {
    connect: vi.fn().mockResolvedValue(mockConnection),
  },
}));

import amqp from 'amqplib';

// ──────────────────────────────────────────────────────────────────────────────

const baseConfig: RabbitMQBusConfig = {
  type: 'rabbitmq',
  url: 'amqp://localhost:5672',
};

const configWithAuth: RabbitMQBusConfig = {
  type: 'rabbitmq',
  url: 'amqp://rabbit.local:5672',
  auth: { username: 'user', password: 'secret' },
  exchange: 'my-exchange',
  routing_key_template: 'events.{eventType}',
};

function makePayload() {
  return {
    context: {
      specversion: '0.6.0-draft',
      id: 'evt-1',
      source: 'https://example.com/',
      type: 'dev.cdevents.build.started.0.3.0',
      timestamp: new Date().toISOString(),
      chainId: 'chain-1',
    },
    subject: { id: 'sub-1', content: {} },
  } as Parameters<RabbitMQBus['emit']>[2];
}

describe('RabbitMQBus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // restore mock resolved values cleared by clearAllMocks
    mockConnection.createChannel.mockResolvedValue(mockChannel);
    mockConnection.close.mockResolvedValue(undefined);
    mockChannel.assertExchange.mockResolvedValue(undefined);
    mockChannel.publish.mockReturnValue(true);
    mockChannel.checkQueue.mockResolvedValue({ messageCount: 5, consumerCount: 1 });
    mockChannel.purgeQueue.mockResolvedValue(undefined);
    mockChannel.close.mockResolvedValue(undefined);
    (amqp.connect as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnection);
  });

  describe('connect', () => {
    it('calls amqp.connect with the configured url', async () => {
      const bus = new RabbitMQBus('default', baseConfig);
      await bus.connect();
      expect(amqp.connect).toHaveBeenCalledWith('amqp://localhost:5672');
    });

    it('embeds credentials in the URL when auth is provided', async () => {
      const bus = new RabbitMQBus('default', configWithAuth);
      await bus.connect();
      const calledUrl = (amqp.connect as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('user');
      expect(calledUrl).toContain('secret');
    });

    it('creates a channel after connecting', async () => {
      const bus = new RabbitMQBus('default', baseConfig);
      await bus.connect();
      expect(mockConnection.createChannel).toHaveBeenCalled();
    });
  });

  describe('emit', () => {
    it('publishes to the default exchange with event type as routing key', async () => {
      const bus = new RabbitMQBus('default', baseConfig);
      await bus.connect();
      await bus.emit('dev.cdevents.build.started.0.3.0', 'evt-1', makePayload());
      expect(mockChannel.assertExchange).toHaveBeenCalledWith('cdevents', 'topic', {
        durable: true,
      });
      expect(mockChannel.publish).toHaveBeenCalledWith(
        'cdevents',
        'dev.cdevents.build.started.0.3.0',
        expect.any(Buffer),
        expect.objectContaining({ contentType: 'application/json', persistent: true }),
      );
    });

    it('uses the configured exchange and routing key template', async () => {
      const bus = new RabbitMQBus('default', configWithAuth);
      await bus.connect();
      await bus.emit('dev.cdevents.build.started.0.3.0', 'evt-1', makePayload());
      expect(mockChannel.assertExchange).toHaveBeenCalledWith('my-exchange', 'topic', {
        durable: true,
      });
      expect(mockChannel.publish).toHaveBeenCalledWith(
        'my-exchange',
        'events.dev.cdevents.build.started.0.3.0',
        expect.any(Buffer),
        expect.any(Object),
      );
    });

    it('throws when not connected', async () => {
      const bus = new RabbitMQBus('default', baseConfig);
      await expect(bus.emit('type', 'id', makePayload())).rejects.toThrow('RabbitMQ not connected');
    });
  });

  describe('inspect', () => {
    it('returns queue depth information', async () => {
      const bus = new RabbitMQBus('default', baseConfig);
      await bus.connect();
      const result = await bus.inspect();
      expect(result.type).toBe('rabbitmq');
      expect(result.details).toMatchObject({ messageCount: 5, consumerCount: 1 });
    });

    it('returns a graceful result when queue is not found', async () => {
      mockChannel.checkQueue.mockRejectedValue(new Error('NOT_FOUND'));
      const bus = new RabbitMQBus('default', baseConfig);
      await bus.connect();
      const result = await bus.inspect();
      expect(result.type).toBe('rabbitmq');
      expect(result.details).toHaveProperty('note');
    });

    it('throws when not connected', async () => {
      const bus = new RabbitMQBus('default', baseConfig);
      await expect(bus.inspect()).rejects.toThrow('RabbitMQ not connected');
    });
  });

  describe('purge', () => {
    it('purges the default queue (exchange name)', async () => {
      const bus = new RabbitMQBus('default', configWithAuth);
      await bus.connect();
      await bus.purge();
      expect(mockChannel.purgeQueue).toHaveBeenCalledWith('my-exchange');
    });

    it('purges a specific queue when opts.queue is provided', async () => {
      const bus = new RabbitMQBus('default', baseConfig);
      await bus.connect();
      await bus.purge({ queue: 'my-queue' });
      expect(mockChannel.purgeQueue).toHaveBeenCalledWith('my-queue');
    });

    it('throws when not connected', async () => {
      const bus = new RabbitMQBus('default', baseConfig);
      await expect(bus.purge()).rejects.toThrow('RabbitMQ not connected');
    });
  });

  describe('disconnect', () => {
    it('closes the channel and connection', async () => {
      const bus = new RabbitMQBus('default', baseConfig);
      await bus.connect();
      await bus.disconnect();
      expect(mockChannel.close).toHaveBeenCalled();
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it('is safe to call when not connected', async () => {
      const bus = new RabbitMQBus('default', baseConfig);
      await expect(bus.disconnect()).resolves.not.toThrow();
    });
  });
});
