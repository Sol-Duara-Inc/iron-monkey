/**
 * Phase 2 — the STRUCTURAL blocking wait (RFC §4.7) at emission time. The
 * timing plan schedules siblings past nominal blocking ends; these tests
 * prove the runner enforces the wait for REAL, including under chaos: a
 * `late` injection inside a blocking chain stalls the spawning chain, while
 * detached chains never gate anything.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveChainTree } from '../../src/workflow/chain-tree.js';
import { createRegistry } from '../../src/expressions/loader.js';
import { buildManifest } from '../../src/manifest/builder.js';
import { applyInjections } from '../../src/injection/apply.js';
import { parseInjections } from '../../src/injection/parser.js';
import { executeManifest } from '../../src/emitter/runner.js';
import { createLogger, setLogger } from '../../src/logger/index.js';
import type { WorkflowFile } from '../../src/workflow/types.js';
import type { IronMonkeyConfig } from '../../src/config/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(__dirname, '../../schemas/cdevents');

const TS_STARTED = 'dev.cdevents.testsuiterun.started.0.3.0';
const TS_FINISHED = 'dev.cdevents.testsuiterun.finished.0.3.0';
const TC_STARTED = 'dev.cdevents.testcaserun.started.0.3.0';
const TC_FINISHED = 'dev.cdevents.testcaserun.finished.0.3.0';
const TICKET_CREATED = 'dev.cdevents.ticket.created.0.2.0';

const config: IronMonkeyConfig = {
  buses: { default: { type: 'rabbitmq', url: 'amqp://x' } },
  tools: {},
  schemasPath: SCHEMAS_DIR,
};

function wf(produces: unknown[]): WorkflowFile {
  return {
    workflow: {
      id: 'phase2-wf',
      name: 'phase2-wf',
      defaults: { tool: 't', source: 'https://t.example/' },
      produces,
    },
  } as unknown as WorkflowFile;
}

/** A recording bus: captures (type, wall-clock ms) per emit, in order. */
function recordingBus() {
  const emitted: { type: string; at: number }[] = [];
  return {
    emitted,
    bus: {
      connect: async () => {},
      emit: async (_t: string, _id: string, payload: { context: { type: string } }) => {
        emitted.push({ type: payload.context.type, at: Date.now() });
      },
      inspect: async () => ({ type: 'mock', details: {} }),
      purge: async () => {},
      disconnect: async () => {},
    },
  };
}

async function run(workflow: WorkflowFile, injections: string[] = []) {
  setLogger(createLogger({ level: 'fatal', format: 'json' }));
  const chain = resolveChainTree(workflow, createRegistry([]));
  let manifest = await buildManifest({ id: 'phase2-wf', name: 'phase2-wf' }, chain, config, {
    noConduit: true,
    interval: 0,
    seed: 5,
  });
  if (injections.length > 0) manifest = applyInjections(manifest, parseInjections(injections));
  const { emitted, bus } = recordingBus();
  await executeManifest(manifest, bus as never, createLogger({ level: 'fatal', format: 'json' }));
  return emitted;
}

describe('executeManifest — structural blocking wait', () => {
  it('emits every blocking-chain event before the next main sibling', async () => {
    const emitted = await run(
      wf([
        {
          event: TS_STARTED,
          spawn: [[{ event: TC_STARTED }, { event: TC_FINISHED }], [{ event: TC_STARTED }]],
        },
        { event: TS_FINISHED },
      ]),
    );
    const types = emitted.map((e) => e.type);
    const siblingIdx = types.indexOf(TS_FINISHED);
    expect(types.filter((t) => t.startsWith('dev.cdevents.testcaserun'))).toHaveLength(3);
    // ALL three blocking events precede the sibling.
    emitted.forEach((e, i) => {
      if (e.type.startsWith('dev.cdevents.testcaserun')) expect(i).toBeLessThan(siblingIdx);
    });
  });

  it('a late injection inside a blocking chain stalls the sibling (chaos-true wait)', async () => {
    const emitted = await run(
      wf([{ event: TS_STARTED, spawn: [{ event: TC_FINISHED }] }, { event: TS_FINISHED }]),
      ['late:testcaserun-finished:150'],
    );
    const blocked = emitted.find((e) => e.type === TC_FINISHED)!;
    const sibling = emitted.find((e) => e.type === TS_FINISHED)!;
    expect(sibling.at).toBeGreaterThanOrEqual(blocked.at);
    expect(emitted.map((e) => e.type).indexOf(TC_FINISHED)).toBeLessThan(
      emitted.map((e) => e.type).indexOf(TS_FINISHED),
    );
  });

  it('detached chains never gate the sibling, even when injected late', async () => {
    const emitted = await run(
      wf([{ event: TS_STARTED, detach: [{ event: TICKET_CREATED }] }, { event: TS_FINISHED }]),
      ['late:ticket-created:200'],
    );
    const detachedEmit = emitted.find((e) => e.type === TICKET_CREATED)!;
    const sibling = emitted.find((e) => e.type === TS_FINISHED)!;
    // Sibling fired without waiting; detached completed later but still emitted.
    expect(sibling.at).toBeLessThan(detachedEmit.at);
  });

  it("a blocking chain's detached grandchild does not gate the outer sibling", async () => {
    const emitted = await run(
      wf([
        {
          event: TS_STARTED,
          spawn: [{ event: TC_STARTED, detach: [{ event: TICKET_CREATED }] }],
        },
        { event: TS_FINISHED },
      ]),
      ['late:ticket-created:200'],
    );
    const grandchild = emitted.find((e) => e.type === TICKET_CREATED)!;
    const sibling = emitted.find((e) => e.type === TS_FINISHED)!;
    // Blocking child (TC_STARTED) gates; its DETACHED grandchild must not.
    expect(sibling.at).toBeLessThan(grandchild.at);
    expect(emitted.map((e) => e.type)).toContain(TICKET_CREATED); // still drained
  });
});
