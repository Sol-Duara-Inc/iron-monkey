/**
 * Kafka ADMINISTRATIVE surface — the reason the adapter exists (decision
 * 2026-08-07): cleaning up RabbitMQ/Kafka from IM's side during Junction Box
 * tests and demos. These tests cover exactly that surface — purge (consumer
 * group offset reset), the status/inspect query, and clean restart
 * (disconnect) — with kafkajs mocked. Nothing here chases pitching-path
 * coverage: `src/bus/kafka.ts` is excluded from unit-coverage goals
 * (vitest.config.ts) and the note in tests/bus/interface.test.ts governs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const admin = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  fetchTopicMetadata: vi.fn(),
  resetOffsets: vi.fn(),
};
const producer = { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn() };

vi.mock('kafkajs', () => ({
  Kafka: vi.fn(() => ({ admin: () => admin, producer: () => producer })),
}));

import { KafkaBus } from '../../src/bus/kafka.js';
import type { KafkaBusConfig } from '../../src/config/types.js';

const config: KafkaBusConfig = {
  type: 'kafka',
  brokers: ['kafka-1.local:9092'],
  topic: 'demo-events',
} as KafkaBusConfig;

async function connectedBus(): Promise<KafkaBus> {
  const bus = new KafkaBus('kafka-demo', config);
  await bus.connect();
  return bus;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('KafkaBus — administrative surface (demo cleanup)', () => {
  it('purge with a group resets consumer offsets to LATEST on the configured topic', async () => {
    const bus = await connectedBus();
    await bus.purge({ group: 'jb-demo' });

    expect(admin.connect).toHaveBeenCalled();
    expect(admin.resetOffsets).toHaveBeenCalledWith({
      groupId: 'jb-demo',
      topic: 'demo-events',
      earliest: false, // latest — clear the backlog, never replay it
    });
    expect(admin.disconnect).toHaveBeenCalled(); // always released
  });

  it('purge without a group is a guarded no-op (warns, never deletes topics)', async () => {
    const bus = await connectedBus();
    await bus.purge();
    expect(admin.resetOffsets).not.toHaveBeenCalled();
    expect(admin.connect).not.toHaveBeenCalled();
  });

  it('releases the admin connection even when the offset reset fails', async () => {
    const bus = await connectedBus();
    admin.resetOffsets.mockRejectedValueOnce(new Error('broker unavailable'));
    await expect(bus.purge({ group: 'jb-demo' })).rejects.toThrow('broker unavailable');
    expect(admin.disconnect).toHaveBeenCalled();
  });

  it('inspect reports the topic and partition count for status checks', async () => {
    const bus = await connectedBus();
    admin.fetchTopicMetadata.mockResolvedValueOnce({
      topics: [{ name: 'demo-events', partitions: [{}, {}, {}] }],
    });

    const result = await bus.inspect();
    expect(result).toEqual({ type: 'kafka', details: { topic: 'demo-events', partitions: 3 } });
    expect(admin.disconnect).toHaveBeenCalled();
  });

  it('inspect reports zero partitions when the topic does not exist yet', async () => {
    const bus = await connectedBus();
    admin.fetchTopicMetadata.mockResolvedValueOnce({ topics: [] });
    const result = await bus.inspect();
    expect(result.details.partitions).toBe(0);
  });

  it('purge and inspect demand a connected bus (restart discipline)', async () => {
    const bus = new KafkaBus('kafka-demo', config);
    await expect(bus.purge({ group: 'jb-demo' })).rejects.toThrow('Kafka not connected');
    await expect(bus.inspect()).rejects.toThrow('Kafka not connected');
  });

  it('disconnect tolerates producer errors and resets state for a clean restart', async () => {
    const bus = await connectedBus();
    producer.disconnect.mockRejectedValueOnce(new Error('already gone'));
    await expect(bus.disconnect()).resolves.toBeUndefined();
    // After disconnect the bus is restart-clean: admin surfaces demand reconnect.
    await expect(bus.inspect()).rejects.toThrow('Kafka not connected');
  });
});
