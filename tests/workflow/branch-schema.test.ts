/**
 * Proves the RUNTIME validators (the exact schema objects `loadBundle` and
 * `validateWorkflow` compile) accept the concurrent-branch grammar — a nested
 * array under `produces`. This closes the gap where chain-tree.ts resolved
 * branches but the schemas rejected the YAML before resolution could run.
 */
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { expressionBundleSchema } from '../../src/expressions/schema.js';
import { workflowSchema } from '../../src/workflow/schema.js';

// Same AJV construction the loaders use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvCtor = (Ajv as any).default ?? Ajv;
const ajv = new AjvCtor({ allErrors: true });
const validateBundle = ajv.compile(expressionBundleSchema);
const validateWf = ajv.compile(workflowSchema);

const TS_QUEUED = 'dev.cdevents.testsuiterun.queued.0.5.1';
const TS_STARTED = 'dev.cdevents.testsuiterun.started.0.5.1';
const TS_FINISHED = 'dev.cdevents.testsuiterun.finished.0.5.1';
const TC_QUEUED = 'dev.cdevents.testcaserun.queued.0.5.1';
const TC_STARTED = 'dev.cdevents.testcaserun.started.0.5.1';
const TC_FINISHED = 'dev.cdevents.testcaserun.finished.0.5.1';

const testCaseBranch = [{ event: TC_QUEUED }, { event: TC_STARTED }, { event: TC_FINISHED }];

describe('expression bundle schema — concurrent branches', () => {
  it("accepts the Shipwreck SA `verify` shape (two branches under an event's produces)", () => {
    const verify = {
      group: 'spin-dev',
      author: 'shipwreck-sa',
      expression: 'verify',
      produces: [
        { event: TS_QUEUED },
        { event: TS_STARTED, produces: [testCaseBranch, testCaseBranch] },
        { event: TS_FINISHED },
      ],
    };
    expect(validateBundle(verify), JSON.stringify(validateBundle.errors)).toBe(true);
  });

  it('still accepts a plain (no-branch) bundle', () => {
    const plain = {
      group: 'spin-dev',
      author: 'shipwreck-sa',
      expression: 'ticket-associate',
      produces: [{ event: 'dev.cdevents.ticket.created.0.5.1' }],
    };
    expect(validateBundle(plain)).toBe(true);
  });

  it('rejects an empty branch (minItems)', () => {
    const bad = {
      group: 'spin-dev',
      author: 'shipwreck-sa',
      expression: 'verify',
      produces: [{ event: TS_STARTED, produces: [[]] }],
    };
    expect(validateBundle(bad)).toBe(false);
  });

  it('rejects a branch member that is neither event, expression, nor branch', () => {
    const bad = {
      group: 'spin-dev',
      author: 'shipwreck-sa',
      expression: 'verify',
      produces: [{ event: TS_STARTED, produces: [[{ nonsense: true }]] }],
    };
    expect(validateBundle(bad)).toBe(false);
  });
});

describe('workflow schema — concurrent branches', () => {
  it('accepts a top-level branch in workflow.produces', () => {
    const wf = {
      workflow: {
        id: 'wf',
        name: 'wf',
        cdrus: { version: 1 },
        produces: [
          { event: 'dev.cdevents.pipelinerun.started.0.5.1' },
          [
            { event: 'dev.cdevents.build.started.0.5.1' },
            { event: 'dev.cdevents.build.finished.0.5.1' },
          ],
          { event: 'dev.cdevents.pipelinerun.finished.0.5.1' },
        ],
      },
    };
    expect(validateWf(wf), JSON.stringify(validateWf.errors)).toBe(true);
  });

  it('accepts branches nested under an event item, mixed with detach', () => {
    const wf = {
      workflow: {
        id: 'wf',
        name: 'wf',
        cdrus: { version: 1 },
        produces: [
          {
            event: 'dev.cdevents.taskrun.started.0.5.1',
            produces: [testCaseBranch, testCaseBranch],
            detach: [{ expression: 'ticket-associate' }],
          },
        ],
      },
    };
    expect(validateWf(wf), JSON.stringify(validateWf.errors)).toBe(true);
  });

  it('still accepts a plain linear workflow (no branches)', () => {
    const wf = {
      workflow: {
        id: 'wf',
        name: 'wf',
        cdrus: { version: 1 },
        produces: [{ event: 'dev.cdevents.pipelinerun.started.0.5.1' }],
      },
    };
    expect(validateWf(wf)).toBe(true);
  });

  it('still rejects the forbidden `bus` key (Sympraxis paradigm preserved)', () => {
    const wf = {
      workflow: {
        id: 'wf',
        name: 'wf',
        cdrus: { version: 1 },
        bus: 'default',
        produces: [{ event: 'dev.cdevents.pipelinerun.started.0.5.1' }],
      },
    };
    expect(validateWf(wf)).toBe(false);
  });
});

// ── `as` anchor + canonical timing ──────────────────────────────────────────
// Guards two cross-repo contracts with Junction Box:
//   1. IM must ACCEPT the `as:` anchor field (§4.9) so JB's `@anchor` selectors
//      can bind to a named event. IM never consumes `as` (binding is entirely
//      consumer-side); it only has to not reject the bundle/workflow. If a
//      future overlay edit re-tightens `additionalProperties`, this fails.
//   2. Timing (`timeout_ms` / `min_wait_ms`) is canonical and typed `number`.
//      An earlier IM overlay re-declared it as `integer`, which rejected
//      fractional millisecond values the canonical schema (and JB) accept,
//      silently splitting the two schemas. These tests lock the `number` type.
const BUILD_STARTED = 'dev.cdevents.build.started.0.5.1';

describe('schema — `as` anchor field (§4.9, JB @anchor lockstep)', () => {
  it('workflow event_item accepts `as`', () => {
    const wf = {
      workflow: {
        id: 'wf',
        name: 'wf',
        cdrus: { version: 1 },
        produces: [{ event: BUILD_STARTED, as: 'kickoff' }],
      },
    };
    expect(validateWf(wf), JSON.stringify(validateWf.errors)).toBe(true);
  });

  it('expression bundle event_item accepts `as`', () => {
    const bundle = {
      group: 'sol-duara',
      author: 'dsanyika',
      expression: 'anchored',
      produces: [{ event: BUILD_STARTED, as: 'build-kicked-off' }],
    };
    expect(validateBundle(bundle), JSON.stringify(validateBundle.errors)).toBe(true);
  });

  it('accepts `as` on events nested inside detach and concurrent branches', () => {
    const wf = {
      workflow: {
        id: 'wf',
        name: 'wf',
        cdrus: { version: 1 },
        produces: [
          {
            event: 'dev.cdevents.taskrun.started.0.5.1',
            as: 'fanout-start',
            produces: [
              [{ event: TC_STARTED, as: 'branch-a-event' }],
              [{ event: TC_FINISHED, as: 'branch-b-event' }],
            ],
            detach: [
              { event: 'dev.cdevents.repository.created.0.5.1', as: 'detached-side-effect' },
            ],
          },
        ],
      },
    };
    expect(validateWf(wf), JSON.stringify(validateWf.errors)).toBe(true);
  });

  it('still rejects an unknown event field (additionalProperties:false preserved)', () => {
    const wf = {
      workflow: {
        id: 'wf',
        name: 'wf',
        cdrus: { version: 1 },
        produces: [{ event: BUILD_STARTED, nonsense: true }],
      },
    };
    expect(validateWf(wf)).toBe(false);
  });
});

describe('schema — canonical timing is `number` (not `integer`)', () => {
  it('workflow accepts fractional timeout_ms / min_wait_ms on an event', () => {
    const wf = {
      workflow: {
        id: 'wf',
        name: 'wf',
        cdrus: { version: 1 },
        produces: [{ event: BUILD_STARTED, timeout_ms: 100.5, min_wait_ms: 0.25 }],
      },
    };
    expect(validateWf(wf), JSON.stringify(validateWf.errors)).toBe(true);
  });

  it('workflow accepts fractional timing on an expression ref and a per-event override', () => {
    const wf = {
      workflow: {
        id: 'wf',
        name: 'wf',
        cdrus: { version: 1 },
        produces: [
          {
            expression: 'build',
            timeout_ms: 1500.75,
            overrides: { 'build.finished': { timeout_ms: 250.5 } },
          },
        ],
      },
    };
    expect(validateWf(wf), JSON.stringify(validateWf.errors)).toBe(true);
  });

  it('expression bundle accepts fractional timeout_ms on an event', () => {
    const bundle = {
      group: 'sol-duara',
      author: 'dsanyika',
      expression: 'timed',
      produces: [{ event: BUILD_STARTED, timeout_ms: 100.5 }],
    };
    expect(validateBundle(bundle), JSON.stringify(validateBundle.errors)).toBe(true);
  });

  it('still accepts integer timing (no regression for whole-millisecond values)', () => {
    const wf = {
      workflow: {
        id: 'wf',
        name: 'wf',
        cdrus: { version: 1 },
        produces: [{ event: BUILD_STARTED, timeout_ms: 300000, min_wait_ms: 100 }],
      },
    };
    expect(validateWf(wf)).toBe(true);
  });

  it('still rejects negative timing (minimum:0 preserved)', () => {
    const wf = {
      workflow: {
        id: 'wf',
        name: 'wf',
        cdrus: { version: 1 },
        produces: [{ event: BUILD_STARTED, timeout_ms: -1 }],
      },
    };
    expect(validateWf(wf)).toBe(false);
  });
});

// ── workflow.id is path-safe (^[a-z][a-z0-9-]*$) ────────────────────────────
// The id is used directly as a storage-path segment, so the canonical schema
// constrains it to lowercase alphanumerics + hyphens, starting with a letter.
// IM's overlay must NOT loosen `id` (unlike `event`/`source`), so this proves
// the pattern survives into the runtime validator.
describe('workflow schema — id is path-safe', () => {
  const wfWithId = (id: string) => ({
    workflow: { id, name: 'wf', cdrus: { version: 1 }, produces: [{ event: BUILD_STARTED }] },
  });

  it('accepts a plain lowercase id', () => {
    expect(validateWf(wfWithId('wf')), JSON.stringify(validateWf.errors)).toBe(true);
  });

  it('accepts lowercase, digits, and hyphens (the real example shape)', () => {
    expect(
      validateWf(wfWithId('cdcon-2026-anchored-release-showcase')),
      JSON.stringify(validateWf.errors),
    ).toBe(true);
  });

  it.each([
    ['uppercase letters', 'MyWorkflow'],
    ['an underscore', 'my_workflow'],
    ['a leading digit', '9-bad'],
    ['a leading hyphen', '-bad'],
    ['a dot (path-unsafe)', 'my.workflow'],
    ['a slash (path-unsafe)', 'my/workflow'],
    ['a space', 'my workflow'],
  ])('rejects an id with %s', (_label, id) => {
    expect(validateWf(wfWithId(id))).toBe(false);
  });
});
