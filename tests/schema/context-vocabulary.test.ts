/**
 * `context.chainId` and `context.workflowId` across every strict schema in the
 * shipped corpus, `baseevent.json` included. `chainId` is upstream CDEvents
 * vocabulary; `workflowId` is ours — the one context member this corpus carries
 * that `cdevents/spec` does not. Nothing compares the corpus to upstream, so a
 * re-mirror that drops `workflowId` is caught here or nowhere.
 *
 * The rule that is easy to get wrong, and was: a schema whose `context` sets
 * `additionalProperties: false` refuses every member it does not list. Half the
 * pair is therefore not a cosmetic gap, it is a schema that refuses every
 * envelope carrying the other. `baseevent.json` shipped in exactly that state —
 * strict context, neither member declared, no `links` either — while
 * `docs/SCHEMAS.md` described it as the schema "used for chainId validation".
 *
 * So these tests do not ask whether the members appear somewhere. They assert
 * the coupling that the gap broke: every member the builder stamps on an event
 * bound for a strict schema is declared by the base event, and a strict schema
 * that stops declaring one refuses an envelope carrying it.
 *
 * "Strict" is the 45 sanctioned `dev.cdevents.*` schemas plus `baseevent.json`,
 * which share one context vocabulary. The vendor and layered `com.*` schemas
 * leave `context` open, declare no context members, and so cannot refuse one —
 * they are outside this file by construction, not by omission.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildManifest } from '../../src/manifest/builder.js';
import { resolveChainTree } from '../../src/workflow/chain-tree.js';
import { createRegistry } from '../../src/expressions/loader.js';
import { validateEvent } from '../../src/schema/validator.js';
import { createLogger, setLogger } from '../../src/logger/index.js';
import type { WorkflowFile } from '../../src/workflow/types.js';
import type { IronMonkeyConfig } from '../../src/config/types.js';

setLogger(createLogger({ level: 'fatal', format: 'json' }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(__dirname, '../../schemas/cdevents');
const BASE_EVENT = path.join(SCHEMAS_DIR, 'baseevent.json');

/** The chain/workflow pair every strict `context` block must admit. */
const PAIR = ['chainId', 'workflowId'] as const;

interface StrictSchema {
  file: string;
  contextProps: Record<string, unknown>;
}

/** Every top-level schema whose `context` refuses undeclared members. */
function strictContextSchemas(): StrictSchema[] {
  const out: StrictSchema[] = [];
  for (const file of readdirSync(SCHEMAS_DIR).sort()) {
    if (!file.endsWith('.json')) continue;
    const schema = JSON.parse(readFileSync(path.join(SCHEMAS_DIR, file), 'utf-8')) as {
      properties?: { context?: { additionalProperties?: unknown; properties?: unknown } };
    };
    const ctx = schema.properties?.context;
    if (ctx?.additionalProperties !== false || typeof ctx.properties !== 'object') continue;
    out.push({ file, contextProps: ctx.properties as Record<string, unknown> });
  }
  return out;
}

function readBaseEvent(): Record<string, unknown> {
  return JSON.parse(readFileSync(BASE_EVENT, 'utf-8')) as Record<string, unknown>;
}

interface Envelope {
  context: Record<string, unknown>;
  subject: { id: string; content: Record<string, unknown> };
}

/**
 * A base-typed envelope — the only `context.type` this schema's pattern admits —
 * carrying a real PATH link, so the relative `links` `$ref` has to resolve for
 * it to validate at all.
 */
function baseTypedEvent(): Envelope {
  return {
    context: {
      specversion: '0.6.0-draft',
      id: '550e8400-e29b-41d4-a716-446655440000',
      source: 'https://iron-monkey.example.com/',
      type: 'dev.cdevents.event.base.0.1.0-draft',
      timestamp: '2026-11-02T17:45:07.000Z',
      schemaUri: 'https://cdevents.dev/0.6.0-draft/schema/event-base-event',
      workflowId: 'platform-svc-release',
      chainId: '0190f8c2-6d4a-7b31-a2e5-9c1f4d8e0071',
      links: [{ linkType: 'PATH', from: { contextId: '6a1f0c3e-2b4d-4e8f-9a7c-1d2e3f4a5b6c' } }],
    },
    subject: { id: 'subject-123', content: {} },
  };
}

describe('the corpus declares the pair — every strict context, no exceptions', () => {
  it('declares both halves wherever it declares either', () => {
    const offenders = strictContextSchemas()
      .map(({ file, contextProps }) => ({
        file,
        missing: PAIR.filter((m) => !(m in contextProps)),
      }))
      .filter((o) => o.missing.length > 0)
      .map((o) => `${o.file} missing ${o.missing.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  it('counts baseevent.json among the strict schemas it just checked', () => {
    // Without this, the test above is satisfiable by DELETING
    // `additionalProperties: false` from a schema instead of declaring the
    // member — which would silently drop that schema out of the sample it
    // guards. The pair is admitted because it is declared, not because the
    // block stopped refusing.
    const files = strictContextSchemas().map((s) => s.file);
    expect(files).toContain('baseevent.json');
    expect(files.length).toBeGreaterThanOrEqual(46);
  });

  it('keeps baseevent.json OUT of the per-event type lookup', () => {
    // It pins `context.type` with a `pattern`, not a one-value `enum`, and
    // carries no `x-cdevents.type` — so `extractTypeString` skips it and no
    // emitted event is ever validated against it. Giving it a type enum to
    // "complete" it would start matching real events against a base-event
    // contract they cannot satisfy.
    const schema = readBaseEvent() as {
      'x-cdevents'?: unknown;
      properties: { context: { properties: { type: Record<string, unknown> } } };
    };
    const typeBlock = schema.properties.context.properties.type;
    expect(schema['x-cdevents']).toBeUndefined();
    expect(typeBlock.enum).toBeUndefined();
    expect(typeBlock.pattern).toBeTypeOf('string');
  });
});

describe('the base event declares every member the builder stamps', () => {
  it('leaves no emitted context key undeclared', async () => {
    // A live coupling, not a literal list: when `buildEvent` gains a context
    // member on sanctioned events and this schema does not, this fails and
    // names the member. Sanctioned types only, deliberately — `inherits` is
    // stamped solely on layered types, whose schemas leave `context` open, so
    // it never meets a strict block and is not part of this vocabulary.
    // tests/manifest/lineage.test.ts guards that it stays off sanctioned events.
    const config: IronMonkeyConfig = {
      buses: { default: { type: 'rabbitmq', url: 'amqp://x' } },
      tools: {},
      schemasPath: SCHEMAS_DIR,
      defaults: { source: 'https://iron-monkey.example.com/' },
    };
    const workflow = {
      workflow: {
        id: 'vocab-wf',
        name: 'vocab-wf',
        defaults: { tool: 't', source: 'https://t.example/' },
        produces: [
          { event: 'dev.cdevents.build.started.0.3.0' },
          { event: 'dev.cdevents.build.finished.0.3.0' },
        ],
      },
    } as unknown as WorkflowFile;

    const chain = resolveChainTree(workflow, createRegistry([]));
    const manifest = await buildManifest({ id: 'vocab-wf', name: 'vocab-wf' }, chain, config, {
      noConduit: true,
      interval: 0,
      // Synthesis fills `subject.content` only and never touches `context`, so
      // this holds the fixture steady if a type with required content is added.
      synth: true,
    });

    // Both shapes matter: the first event carries `links` present-but-
    // undefined, and AJV counts that as a property for `additionalProperties`.
    const emitted = new Set<string>();
    for (const event of manifest.events) {
      for (const key of Object.keys(event.payload.context)) emitted.add(key);
    }
    expect(emitted.has('chainId')).toBe(true);
    expect(emitted.has('workflowId')).toBe(true);
    expect(emitted.has('links')).toBe(true);

    const declared = Object.keys(
      (readBaseEvent() as { properties: { context: { properties: object } } }).properties.context
        .properties,
    );
    expect([...emitted].filter((k) => !declared.includes(k))).toEqual([]);
  });
});

describe('the declaration is load-bearing', () => {
  it('accepts the envelope it declares the pair for, and refuses it without workflowId', () => {
    const envelope = baseTypedEvent();
    expect(validateEvent(envelope, readBaseEvent())).toEqual({ valid: true });

    // The mutation this file exists to catch. The mutant needs its OWN `$id`:
    // keeping the real one hands back the cached real validator (so the test
    // would pass while proving nothing), and DELETING it breaks the relative
    // `links/embeddedlinksarray` ref, which resolves against this schema's
    // `$id` exactly as it does in all 45 per-event schemas.
    const mutant = readBaseEvent() as {
      $id: string;
      properties: { context: { properties: Record<string, unknown> } };
    };
    mutant.$id = 'https://cdevents.dev/0.6.0-draft/schema/event-base-event-no-workflowid';
    delete mutant.properties.context.properties.workflowId;

    const refused = validateEvent(envelope, mutant);
    expect(refused.valid).toBe(false);
    // The proof is the differential, not the wording: `formatAjvErrorLine`
    // drops AJV's `params.additionalProperty`, so the message never names the
    // member it refused. One error, on `/context`, from the one deletion.
    expect(refused.errors).toEqual(['  /context: must NOT have additional properties']);

    // That message does not name the member, so pin the refusal to workflowId:
    // the same envelope WITHOUT it satisfies the mutant. Had some other declared
    // member been deleted instead, this envelope would still be refused.
    const withoutWorkflowId = { ...envelope, context: { ...envelope.context } };
    delete withoutWorkflowId.context.workflowId;
    expect(validateEvent(withoutWorkflowId, mutant)).toEqual({ valid: true });
  });
});
