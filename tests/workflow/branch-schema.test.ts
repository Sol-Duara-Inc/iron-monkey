/**
 * Proves the RUNTIME validators (the exact schema objects `loadBundle` and
 * `validateWorkflow` compile) implement the CDrus 0.1.0 grammar: `spawn` /
 * `detach` in flat and nested forms on events, NO nested lists at chain
 * positions (the retired concurrent-branch grammar), spec-pure expression
 * references on the bundle side, and the enforced event-type pattern
 * (core + `dev.cdeventsx.*` extended forms).
 */
import { describe, it, expect } from 'vitest';
import { createAjv2020 } from '../../src/util/ajv.js';
import { expressionBundleSchema } from '../../src/expressions/schema.js';
import { workflowSchema } from '../../src/workflow/schema.js';

const ajv = createAjv2020();
const validateBundle = ajv.compile(expressionBundleSchema);
const validateWf = ajv.compile(workflowSchema);

const TS_QUEUED = 'dev.cdevents.testsuiterun.queued.0.3.0';
const TS_STARTED = 'dev.cdevents.testsuiterun.started.0.3.0';
const TS_FINISHED = 'dev.cdevents.testsuiterun.finished.0.3.0';
const TC_QUEUED = 'dev.cdevents.testcaserun.queued.0.3.0';
const TC_STARTED = 'dev.cdevents.testcaserun.started.0.3.0';
const TC_FINISHED = 'dev.cdevents.testcaserun.finished.0.3.0';

const testCaseChain = [{ event: TC_QUEUED }, { event: TC_STARTED }, { event: TC_FINISHED }];

function bundle(produces: unknown[]): Record<string, unknown> {
  return { group: 'spin-dev', author: 'shipwreck-sa', expression: 'verify', produces };
}

function wf(produces: unknown[]): Record<string, unknown> {
  return {
    workflow: { id: 'wf', name: 'wf', cdrus: { version: '0.1.0' }, produces },
  };
}

// ── spawn / detach dual forms ─────────────────────────────────────────────────

describe('expression bundle schema — spawn/detach grammar (CDrus 0.1.0)', () => {
  it('accepts nested-form spawn (one Blocking chain per inner list)', () => {
    const doc = bundle([
      { event: TS_QUEUED },
      { event: TS_STARTED, spawn: [testCaseChain, testCaseChain] },
      { event: TS_FINISHED },
    ]);
    expect(validateBundle(doc), JSON.stringify(validateBundle.errors)).toBe(true);
  });

  it('accepts flat-form spawn and detach (one chain)', () => {
    const doc = bundle([
      { event: TS_STARTED, spawn: testCaseChain, detach: [{ event: TC_FINISHED }] },
      { event: TS_FINISHED },
    ]);
    expect(validateBundle(doc), JSON.stringify(validateBundle.errors)).toBe(true);
  });

  it('accepts an expression reference inside a spawned chain', () => {
    const doc = bundle([
      { event: TS_STARTED, detach: [{ expression: 'ticket-associate' }] },
      { event: TS_FINISHED },
    ]);
    expect(validateBundle(doc), JSON.stringify(validateBundle.errors)).toBe(true);
  });

  it('REJECTS a nested list inside produces (retired concurrent-branch grammar)', () => {
    const doc = bundle([
      { event: TS_QUEUED },
      { event: TS_STARTED, produces: [testCaseChain, testCaseChain] },
      { event: TS_FINISHED },
    ]);
    expect(validateBundle(doc)).toBe(false);
  });

  it('REJECTS a nested list at the top level of produces', () => {
    const doc = bundle([{ event: TS_QUEUED }, testCaseChain]);
    expect(validateBundle(doc)).toBe(false);
  });

  it('REJECTS chain-bearing keys on an expression reference (spec-pure refs)', () => {
    const withDetach = bundle([{ expression: 'verify', detach: [{ event: TC_FINISHED }] }]);
    expect(validateBundle(withDetach)).toBe(false);
    const withTool = bundle([{ expression: 'verify', tool: 'jenkins' }]);
    expect(validateBundle(withTool)).toBe(false);
  });

  it('REJECTS a doubly-nested list inside a spawned chain body', () => {
    const doc = bundle([{ event: TS_STARTED, spawn: [[testCaseChain]] }]);
    expect(validateBundle(doc)).toBe(false);
  });
});

// ── event-type pattern ────────────────────────────────────────────────────────

describe('event-type pattern (enforced at 0.1.0 adoption)', () => {
  it('accepts embedded, colon, range, versionless, and extended forms', () => {
    for (const event of [
      'dev.cdevents.build.started.0.3.0',
      'dev.cdevents.build.started:0.1.1',
      'dev.cdevents.build.started:^0.1.0',
      'dev.cdevents.build.started',
      'dev.cdeventsx.mytool-build.started.0.2.0',
    ]) {
      expect(validateBundle(bundle([{ event }])), event).toBe(true);
    }
  });

  it('rejects non-CDEvent strings', () => {
    for (const event of ['A', 'build.started', 'dev.cdevents.build', 'dev.other.build.started']) {
      expect(validateBundle(bundle([{ event }])), event).toBe(false);
    }
  });
});

// ── workflow schema mirrors the grammar ───────────────────────────────────────

describe('workflow schema — spawn/detach grammar (CDrus 0.1.0)', () => {
  it('accepts nested-form spawn with per-event binding fields and anchors', () => {
    const doc = wf([
      { event: TS_QUEUED },
      {
        event: TS_STARTED,
        as: 'verify-started',
        tool: 'spinnaker',
        spawn: [
          [
            { event: TC_STARTED, tool: 'spinnaker' },
            { event: TC_FINISHED, as: 'case-a' },
          ],
          [{ event: TC_STARTED }, { event: TC_FINISHED, as: 'case-b' }],
        ],
      },
      { event: TS_FINISHED },
    ]);
    expect(validateWf(doc), JSON.stringify(validateWf.errors)).toBe(true);
  });

  it('accepts flat-form detach hanging off an event', () => {
    const doc = wf([
      { event: TS_STARTED, detach: [{ event: TC_FINISHED }, { expression: 'async-scan' }] },
      { event: TS_FINISHED },
    ]);
    expect(validateWf(doc), JSON.stringify(validateWf.errors)).toBe(true);
  });

  it('REJECTS a nested list inside a workflow produces', () => {
    const doc = wf([{ event: TS_STARTED, produces: [testCaseChain] }]);
    expect(validateWf(doc)).toBe(false);
  });

  it('REJECTS a nested list at the workflow top level', () => {
    const doc = wf([testCaseChain]);
    expect(validateWf(doc)).toBe(false);
  });

  it('requires cdrus.version to be a string', () => {
    const doc = wf([{ event: TS_STARTED }]);
    (doc.workflow as Record<string, unknown>).cdrus = { version: 1 };
    expect(validateWf(doc)).toBe(false);
  });

  it('keeps workflow expression references bindable (tool/source/overrides)', () => {
    const doc = wf([
      {
        expression: 'build-deploy',
        tool: 'jenkins',
        overrides: {
          'dev.cdevents.build.started': { tool: 'tekton', pipeline: 'alt' },
        },
      },
    ]);
    expect(validateWf(doc), JSON.stringify(validateWf.errors)).toBe(true);
  });

  it('accepts fractional timing values (number, not integer)', () => {
    const doc = wf([{ event: TS_STARTED, timeout_ms: 1500.5, min_wait_ms: 0.25 }]);
    expect(validateWf(doc), JSON.stringify(validateWf.errors)).toBe(true);
  });

  it('accepts anchors matching the identity charset and rejects others', () => {
    expect(validateWf(wf([{ event: TS_STARTED, as: 'suite-done' }]))).toBe(true);
    expect(validateWf(wf([{ event: TS_STARTED, as: 'Suite_Done' }]))).toBe(false);
    expect(validateWf(wf([{ event: TS_STARTED, as: '@suite' }]))).toBe(false);
  });
});
