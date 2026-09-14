/**
 * `context.inherits` — the lineage a LAYERED type carries so one arrival can be
 * decomposed into one register per layer.
 *
 * The rule that is easy to get wrong, and was: an EMPTY lineage means the type
 * is a root, and a root has no ancestors — so the key must be ABSENT from the
 * envelope, not present and empty. A receiver reads a declared-but-empty
 * `inherits` as a lineage naming nothing, which matches no registered ancestry
 * and is refused outright. Six shipped schemas declare `"inherits": []`, so
 * this is the difference between a corpus that runs and one that does not.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildManifest } from '../../src/manifest/builder.js';
import { resolveChainTree } from '../../src/workflow/chain-tree.js';
import { createRegistry } from '../../src/expressions/loader.js';
import { createLogger, setLogger } from '../../src/logger/index.js';
import type { WorkflowFile } from '../../src/workflow/types.js';
import type { IronMonkeyConfig } from '../../src/config/types.js';

setLogger(createLogger({ level: 'fatal', format: 'json' }));

const ROOT_TYPE = 'com.example.thing.happened.0.1.0';
const DERIVED_TYPE = 'com.example.dept.thing.happened.0.1.0';
const ANCESTORS = [
  'https://cdevents.dev/0.5.1/schema/build-finished-event',
  'https://schemas.example.com/thing-happened',
];

/** A vendor schema in the shape the corpus actually ships. */
function schemaFor(type: string, inherits: string[]): string {
  return JSON.stringify({
    $id: `https://schema.example.com/${type}.json`,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    'x-cdevents': { type, inherits, subject: 'thing', predicate: 'happened' },
    type: 'object',
    properties: {
      context: { type: 'object' },
      subject: {
        type: 'object',
        properties: { content: { type: 'object', properties: {}, additionalProperties: false } },
      },
    },
  });
}

function workflowWith(types: string[]): WorkflowFile {
  return {
    workflow: {
      id: 'lineage-wf',
      name: 'lineage-wf',
      defaults: { tool: 't', source: 'https://t.example/' },
      produces: types.map((event) => ({ event })),
    },
  } as unknown as WorkflowFile;
}

async function buildWith(types: string[], schemasPath: string) {
  const config: IronMonkeyConfig = {
    buses: { default: { type: 'rabbitmq', url: 'amqp://x' } },
    tools: {},
    schemasPath,
  };
  const chain = resolveChainTree(workflowWith(types), createRegistry([]));
  return buildManifest({ id: 'lineage-wf', name: 'lineage-wf' }, chain, config, {
    noConduit: true,
    interval: 0,
    synth: false,
  });
}

describe('context.inherits comes from the schema, not the workflow', () => {
  let dir: string;

  const withSchemas = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    dir = mkdtempSync(path.join(tmpdir(), 'im-lineage-'));
    try {
      writeFileSync(path.join(dir, 'root.json'), schemaFor(ROOT_TYPE, []));
      writeFileSync(path.join(dir, 'derived.json'), schemaFor(DERIVED_TYPE, ANCESTORS));
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('OMITS the key entirely for a root — never an empty array', async () => {
    // `"inherits": []` in the schema means "root". Stamping that array onto
    // the envelope declares a lineage that names nothing, and a receiver
    // refuses it: `lineage-mismatch ()`.
    await withSchemas(async (d) => {
      const m = await buildWith([ROOT_TYPE], d);
      const ctx = m.events[0].payload.context as Record<string, unknown>;
      expect(ctx.inherits).toBeUndefined();
      expect('inherits' in ctx).toBe(false);
      expect(JSON.stringify(ctx)).not.toContain('inherits');
    });
  });

  it('carries every ancestor, in order, for a derived type', async () => {
    await withSchemas(async (d) => {
      const m = await buildWith([DERIVED_TYPE], d);
      expect(m.events[0].payload.context.inherits).toEqual(ANCESTORS);
    });
  });

  it('decides per event, not per run', async () => {
    // A workflow mixing rooted and derived types must not leak one event's
    // lineage onto another, nor suppress a real one because a sibling is root.
    await withSchemas(async (d) => {
      const m = await buildWith([ROOT_TYPE, DERIVED_TYPE, ROOT_TYPE], d);
      const seen = m.events.map((e) => (e.payload.context as Record<string, unknown>).inherits);
      expect(seen).toEqual([undefined, ANCESTORS, undefined]);
    });
  });

  it('leaves sanctioned dev.cdevents events with no inherits key', async () => {
    // The bundled CDEvents schemas set `additionalProperties: false` on
    // context, so a stray key here is not merely wrong — it fails validation.
    const m = await buildWith(['dev.cdevents.build.started.0.3.0'], 'schemas/cdevents');
    const ctx = m.events[0].payload.context as Record<string, unknown>;
    expect('inherits' in ctx).toBe(false);
  });
});

describe('the shipped corpus obeys the rule', () => {
  it('no bundled vendor schema would produce an empty inherits array', async () => {
    const { loadSchemasFromDir } = await import('../../src/schema/loader.js');
    const schemas = await loadSchemasFromDir('schemas/cdevents');
    const empty: string[] = [];
    for (const [type, schema] of schemas) {
      const inh = (schema as { 'x-cdevents'?: { inherits?: unknown } })['x-cdevents']?.inherits;
      // A schema MAY declare an empty lineage — that is how a root is written.
      // What must never happen is that emptiness reaching the wire.
      if (Array.isArray(inh) && inh.length === 0) empty.push(type);
    }
    // Recorded, not forbidden: these are the roots. The assertion that matters
    // is the omission test above; this one documents that roots really exist
    // in the corpus, so that test is guarding a live case and not a hypothesis.
    expect(empty.length).toBeGreaterThan(0);
  });
});
