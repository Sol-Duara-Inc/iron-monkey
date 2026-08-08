import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';
import { validateWorkflow } from '../../src/workflow/parser.js';

async function writeTmpYaml(content: string): Promise<string> {
  const dir = await mkdir(path.join(os.tmpdir(), 'iron-monkey-test'), { recursive: true }).then(
    () => path.join(os.tmpdir(), 'iron-monkey-test'),
  );
  const file = path.join(dir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  await writeFile(file, content, 'utf-8');
  return file;
}

// Minimal valid workflow — cdrus block is required by the updated CDrus schema.
const minimalWorkflow = `
workflow:
  id: test-wf
  name: test
  cdrus:
    version: '0.1.0'
  produces:
    - event: dev.cdevents.build.started.0.3.0
      tool: jenkins
      source: https://jenkins.example.com/
`;

describe('validateWorkflow', () => {
  it('parses a valid minimal workflow with produces', async () => {
    const file = await writeTmpYaml(minimalWorkflow);
    const result = await validateWorkflow(file);
    expect(result.workflow.id).toBe('test-wf');
    expect(result.workflow.produces).toHaveLength(1);
    await unlink(file);
  });

  it('parses a workflow with group and author fields', async () => {
    const file = await writeTmpYaml(`
workflow:
  id: test-wf
  group: spin-dev
  author: shipwreck-sa
  name: test
  cdrus:
    version: '0.1.0'
  produces:
    - event: dev.cdevents.build.started.0.3.0
      tool: jenkins
      source: https://jenkins.example.com/
`);
    const result = await validateWorkflow(file);
    expect(result.workflow.group).toBe('spin-dev');
    expect(result.workflow.author).toBe('shipwreck-sa');
    await unlink(file);
  });

  it('rejects a workflow with a bus: field with a clear error', async () => {
    const file = await writeTmpYaml(`
workflow:
  id: test
  name: test
  cdrus:
    version: '0.1.0'
  bus: default
  produces:
    - event: dev.cdevents.build.started.0.3.0
`);
    await expect(validateWorkflow(file)).rejects.toThrow("'bus' field is not allowed");
    await unlink(file);
  });

  it('rejects a workflow with a stages: field with a clear error', async () => {
    const file = await writeTmpYaml(`
workflow:
  id: test
  name: test
  cdrus:
    version: '0.1.0'
  stages:
    - id: build
      type: ci
      tool: jenkins
      events:
        - id: e1
          type: dev.cdevents.build.started.0.3.0
`);
    await expect(validateWorkflow(file)).rejects.toThrow("'stages' field is not allowed");
    await unlink(file);
  });

  it('throws on missing required produces field', async () => {
    const file = await writeTmpYaml(`
workflow:
  id: test
  name: test
  cdrus:
    version: '0.1.0'
`);
    await expect(validateWorkflow(file)).rejects.toThrow('validation failed');
    await unlink(file);
  });

  it('throws on missing required cdrus field', async () => {
    const file = await writeTmpYaml(`
workflow:
  id: test
  name: test
  produces:
    - event: dev.cdevents.build.started.0.3.0
`);
    await expect(validateWorkflow(file)).rejects.toThrow('validation failed');
    await unlink(file);
  });

  it('throws on missing file', async () => {
    await expect(validateWorkflow('/nonexistent/path.yaml')).rejects.toThrow(
      'Cannot read workflow file',
    );
  });
});

describe('validateWorkflow — unparsable YAML', () => {
  it('throws a clear parse error for invalid YAML', async () => {
    const { writeFile } = await import('fs/promises');
    const { makeTmpDir } = await import('../helpers.js');
    const dir = await makeTmpDir('im-wf');
    const bad = path.join(dir, 'broken.yaml');
    await writeFile(bad, 'workflow: [unclosed: {\n', 'utf-8');
    await expect(validateWorkflow(bad)).rejects.toThrow(/Failed to parse workflow YAML/);
  });
});
