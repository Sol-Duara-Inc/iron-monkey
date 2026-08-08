/**
 * CLI smoke tests for `validate` — the name-hint PUBLICATION GATE. The
 * coverage config excludes src/cli from thresholds, but the repo rule is
 * "excluded from thresholds ≠ untested where logic exists": this command
 * decides acceptance, so its two verdicts get real end-to-end coverage via
 * commander (no child processes, no bus — validate never connects).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile } from 'fs/promises';
import path from 'path';
import { validateCommand } from '../../src/cli/commands/validate.js';
import { makeTmpDir, bundleYaml } from '../helpers.js';

const WORKFLOW = `workflow:
  id: smoke-wf
  name: smoke-wf
  cdrus:
    version: "0.1.0"
  defaults:
    tool: smoke-tool
    source: https://smoke.example.com/
  produces:
    - event: dev.cdevents.build.started.0.3.0
    - event: dev.cdevents.build.finished.0.3.0
`;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ['IRON_MONKEY_EXPRESSIONS', 'IRON_MONKEY_BUS_URL', 'IRON_MONKEY_BUS_NAME']) {
    savedEnv[key] = process.env[key];
  }
  process.env.IRON_MONKEY_BUS_URL = 'amqp://localhost:5672';
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function runValidate(workflowPath: string): Promise<void> {
  await validateCommand().parseAsync([workflowPath, '--log-level', 'error'], { from: 'user' });
}

describe('validate CLI — name-hint publication gate', () => {
  it('fails hard when the expression store contains a hint violation', async () => {
    const store = await makeTmpDir('im-cli-store-red');
    // 'build' hint requires started+finished; only a change event given.
    await writeFile(
      path.join(store, 'bad.yaml'),
      bundleYaml('nightly-build', { events: ['dev.cdevents.change.created.0.3.0'] }),
      'utf-8',
    );
    process.env.IRON_MONKEY_EXPRESSIONS = store;

    const wfDir = await makeTmpDir('im-cli-wf');
    const wfPath = path.join(wfDir, 'wf.yaml');
    await writeFile(wfPath, WORKFLOW, 'utf-8');

    await expect(runValidate(wfPath)).rejects.toThrow(/unsatisfied name hints/);
  });

  it('passes a clean store and a valid workflow end-to-end', async () => {
    const store = await makeTmpDir('im-cli-store-green');
    await writeFile(
      path.join(store, 'good.yaml'),
      bundleYaml('change-request', { events: ['dev.cdevents.change.merged.0.3.0'] }),
      'utf-8',
    );
    process.env.IRON_MONKEY_EXPRESSIONS = store;

    const wfDir = await makeTmpDir('im-cli-wf');
    const wfPath = path.join(wfDir, 'wf.yaml');
    await writeFile(wfPath, WORKFLOW, 'utf-8');

    await expect(runValidate(wfPath)).resolves.toBeUndefined();
  });

  it('rejects an invalid workflow document with the schema error', async () => {
    process.env.IRON_MONKEY_EXPRESSIONS = await makeTmpDir('im-cli-store-empty');
    const wfDir = await makeTmpDir('im-cli-wf');
    const wfPath = path.join(wfDir, 'bad.yaml');
    await writeFile(wfPath, 'workflow:\n  id: x\n', 'utf-8');

    await expect(runValidate(wfPath)).rejects.toThrow(/Workflow validation failed/);
  });
});
