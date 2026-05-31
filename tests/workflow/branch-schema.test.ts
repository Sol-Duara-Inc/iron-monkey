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
