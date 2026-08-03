/**
 * Slice 3: the emitter throws detached / branch sub-chains. They are emitted
 * fire-and-forget (the main chain does not wait), each with its own chainId,
 * anchored at the instant the spawning event is reached, and the run drains all
 * sub-chains before returning.
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildManifest } from '../../src/manifest/builder.js';
import { executeManifest } from '../../src/emitter/runner.js';
import { createLogger } from '../../src/logger/index.js';
import type { ResolvedChain, ResolvedChainEvent } from '../../src/workflow/chain-tree.js';
import type { IronMonkeyConfig } from '../../src/config/types.js';
import type { CDEventPayload } from '../../src/manifest/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(__dirname, '../../schemas/cdevents');

const BUILD_STARTED = 'dev.cdevents.build.started.0.3.0';
const BUILD_FINISHED = 'dev.cdevents.build.finished.0.3.0';

const config: IronMonkeyConfig = {
  buses: { default: { type: 'rabbitmq', url: 'amqp://localhost' } },
  tools: { jenkins: { source: 'dev/jenkins' } },
  schemasPath: SCHEMAS_DIR,
};
const meta = { id: 'wf', name: 'wf' };
const logger = createLogger({ level: 'error', format: 'json' });

function ev(treePath: string, order: number, type: string, id: string): ResolvedChainEvent {
  return {
    treePath,
    order,
    workflowEventId: id,
    type,
    tool: 'jenkins',
    source: '',
    pipeline: 'p',
    timeout_ms: 0,
    min_wait_ms: 0,
    subject: { id: `subj-${id}` },
    origin: 'event',
  };
}

/** main: build.started (p0, spawns detach) → build.finished (p1). */
const gatedTree: ResolvedChain = {
  role: 'main',
  chainRef: 'root',
  events: [ev('p0', 0, BUILD_STARTED, 'm0'), ev('p1', 1, BUILD_FINISHED, 'm1')],
  spawns: [
    {
      role: 'detached',
      chainRef: 'p0.d',
      parentChainRef: 'root',
      anchorPath: 'p0',
      linkKind: 'TRIGGER',
      events: [ev('p0.d0.p0', 0, BUILD_STARTED, 'c0'), ev('p0.d0.p1', 1, BUILD_FINISHED, 'c1')],
      spawns: [],
    },
  ],
};

interface EmitRecord {
  type: string;
  eventId: string;
  chainId: string;
}

/** A bus that records every emit; interval:0 manifests fire with no real waiting. */
function recordingBus() {
  const emits: EmitRecord[] = [];
  return {
    emits,
    connect: vi.fn(),
    disconnect: vi.fn(),
    inspect: vi.fn(),
    purge: vi.fn(),
    emit: vi.fn(async (type: string, eventId: string, payload: CDEventPayload) => {
      emits.push({ type, eventId, chainId: payload.context.chainId ?? '' });
    }),
  };
}

describe('executeManifest — sub-chain emission', () => {
  it('emits both the main chain and the detached chain', async () => {
    const manifest = await buildManifest(meta, gatedTree, config, { noConduit: true, interval: 0 });
    const bus = recordingBus();
    await executeManifest(manifest, bus as never, logger);

    // 2 main + 2 detached = 4 emits, each once.
    expect(bus.emits).toHaveLength(4);
    const mainChainId = manifest.chainId;
    const subChainId = manifest.detachedChains![0].chainId;
    expect(bus.emits.filter((e) => e.chainId === mainChainId)).toHaveLength(2);
    expect(bus.emits.filter((e) => e.chainId === subChainId)).toHaveLength(2);
  });

  it('emits each sub-chain event stamped with the sub-chain chainId, not the main', async () => {
    const manifest = await buildManifest(meta, gatedTree, config, { noConduit: true, interval: 0 });
    const bus = recordingBus();
    await executeManifest(manifest, bus as never, logger);

    const dc = manifest.detachedChains![0];
    const subEmits = bus.emits.filter((e) => dc.events.some((se) => se.eventId === e.eventId));
    expect(subEmits.every((e) => e.chainId === dc.chainId)).toBe(true);
    expect(subEmits.map((e) => e.eventId)).toEqual(dc.events.map((e) => e.eventId));
  });

  it('emits the spawning parent event before the sub-chain first event (causal)', async () => {
    const manifest = await buildManifest(meta, gatedTree, config, { noConduit: true, interval: 0 });
    const bus = recordingBus();
    await executeManifest(manifest, bus as never, logger);

    const dc = manifest.detachedChains![0];
    const order = bus.emits.map((e) => e.eventId);
    const parentIdx = order.indexOf(dc.parentEventId);
    const firstSubIdx = order.indexOf(dc.events[0].eventId);
    expect(parentIdx).toBeGreaterThanOrEqual(0);
    expect(firstSubIdx).toBeGreaterThan(parentIdx);
  });

  it('completes (drains) with no detachedChains as a plain run', async () => {
    const plain: ResolvedChain = {
      role: 'main',
      chainRef: 'root',
      events: [ev('p0', 0, BUILD_STARTED, 'm0')],
      spawns: [],
    };
    const manifest = await buildManifest(meta, plain, config, { noConduit: true, interval: 0 });
    const bus = recordingBus();
    await executeManifest(manifest, bus as never, logger);
    expect(bus.emits).toHaveLength(1);
  });
});
