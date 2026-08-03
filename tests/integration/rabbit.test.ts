import { describe, it, expect } from 'vitest';
import { buildManifest } from '../../src/manifest/builder.js';
import { createBus } from '../../src/bus/interface.js';
import type { ResolvedEvent } from '../../src/workflow/parser.js';
import type { IronMonkeyConfig } from '../../src/config/types.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(__dirname, '../../schemas/cdevents');

const BUS_URL = process.env.IRON_MONKEY_BUS_URL ?? 'amqp://localhost:5672';

const events: ResolvedEvent[] = [
  {
    id: 'pipelinerun-started',
    type: 'dev.cdevents.pipelinerun.started.0.3.0',
    tool: 'jenkins',
    source: '',
    pipeline: 'integration-test',
    timeout_ms: 100,
    min_wait_ms: 0,
    subject: {
      id: 'pipeline-run-1',
      content: {
        pipelineName: 'integration-test',
        uri: 'https://jenkins.example.com/job/integration-test/1',
      },
    },
    origin: 'event',
  },
  {
    id: 'build-started',
    type: 'dev.cdevents.build.started.0.3.0',
    tool: 'jenkins',
    source: '',
    pipeline: 'integration-test',
    timeout_ms: 100,
    min_wait_ms: 0,
    subject: { id: 'build-1' },
    origin: 'event',
  },
  {
    id: 'build-finished',
    type: 'dev.cdevents.build.finished.0.3.0',
    tool: 'jenkins',
    source: '',
    pipeline: 'integration-test',
    timeout_ms: 100,
    min_wait_ms: 0,
    subject: { id: 'build-1' },
    origin: 'event',
  },
  {
    id: 'pipelinerun-finished',
    type: 'dev.cdevents.pipelinerun.finished.0.3.0',
    tool: 'jenkins',
    source: '',
    pipeline: 'integration-test',
    timeout_ms: 100,
    min_wait_ms: 0,
    subject: {
      id: 'pipeline-run-1',
      content: { pipelineName: 'integration-test', outcome: 'success' },
    },
    origin: 'event',
  },
];

const config: IronMonkeyConfig = {
  buses: {
    default: {
      type: 'rabbitmq',
      url: BUS_URL,
      exchange: 'cdevents-test',
    },
  },
  tools: { jenkins: { source: 'dev/jenkins' } },
  schemasPath: SCHEMAS_DIR,
};

const meta = { id: 'integration-test', name: 'integration-test' };

describe('RabbitMQ integration', () => {
  it('connects, emits events, and disconnects without error', async () => {
    let bus: Awaited<ReturnType<typeof createBus>> | null = null;

    try {
      bus = await createBus('default', config.buses.default);
      await bus.connect();

      const manifest = await buildManifest(meta, events, config, {
        noConduit: true,
        busName: 'default',
      });

      for (const event of manifest.events) {
        await bus.emit(event.type, event.eventId, event.payload);
      }

      expect(manifest.events).toHaveLength(4);
      expect(manifest.events.every((e) => e.targetBus === 'default')).toBe(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException).code;
      if (
        code === 'ECONNREFUSED' ||
        msg.includes('ACCESS-REFUSED') ||
        msg.includes('ACCESS_REFUSED')
      ) {
        console.log('RabbitMQ not available or not accessible — skipping integration test');
        return;
      }
      throw err;
    } finally {
      await bus?.disconnect();
    }
  });
});
