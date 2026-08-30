/**
 * The drift gate that did not exist.
 *
 * IM vendors the two CDrus grammar schemas and compiles them into its
 * validators. Their canonical home is Sol-Duara-Inc/cdrus. The catalog and the
 * goldens already had byte-equality sync-checks; these two — the files that
 * decide what a workflow may SAY — had none, so they drifted silently until
 * IM was rejecting documents canonical accepts (GH #36).
 *
 * Judge model, same as the catalog and the goldens: canonical wins. On drift,
 * re-copy from canonical; never edit the mirror to agree.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDORED = path.resolve(__dirname, '../../schemas/cdrus');

// Canonical filenames differ from the vendored ones — the mapping is part of
// the contract, not an accident.
const PAIRS: [vendored: string, canonical: string][] = [
  ['workflow.schema.json', 'cdrus-workflow.schema.json'],
  ['expression.schema.json', 'cdrus-expression.schema.json'],
];

const CANONICAL = process.env.CDRUS_SCHEMAS
  ? path.resolve(process.env.CDRUS_SCHEMAS)
  : path.join(process.env.HOME ?? '', 'IdeaProjects/cdrus/schemas');

const present = existsSync(CANONICAL);

describe.skipIf(!present)('CDrus grammar sync-check (canonical: Sol-Duara-Inc/cdrus)', () => {
  it.each(PAIRS)('%s is byte-equal to canonical %s', (vendored, canonical) => {
    expect(readFileSync(path.join(VENDORED, vendored), 'utf-8')).toBe(
      readFileSync(path.join(CANONICAL, canonical), 'utf-8'),
    );
  });
});

// These run everywhere, canonical present or not: they pin the grammar
// features IM was missing, so a future re-mirror that drops them fails here
// rather than in a user's workflow.
describe('the vendored grammar carries the features IM had drifted away from', () => {
  const workflow = JSON.parse(
    readFileSync(path.join(VENDORED, 'workflow.schema.json'), 'utf-8'),
  ) as Record<string, never>;
  const expression = JSON.parse(
    readFileSync(path.join(VENDORED, 'expression.schema.json'), 'utf-8'),
  ) as Record<string, never>;

  it('workflow declares the controller block (name + namespace required)', () => {
    const controller = (
      workflow as unknown as {
        properties: { workflow: { properties: { controller?: { required?: string[] } } } };
      }
    ).properties.workflow.properties.controller;
    expect(
      controller,
      'controller missing — IM would reject a workflow that declares one',
    ).toBeDefined();
    expect(controller?.required).toEqual(expect.arrayContaining(['name', 'namespace']));
  });

  it('the event pattern admits a fully namespaced type, not only dev.cdevents', () => {
    const pattern = JSON.stringify(expression).match(
      /"pattern":\s*"(\^\(?dev\\\\\.cdevents[^"]*)"/,
    );
    expect(pattern, 'event pattern not found in the expression schema').not.toBeNull();
    const re = new RegExp(JSON.parse(`"${pattern![1]}"`) as string);
    expect(re.test('dev.cdevents.build.started.0.3.0')).toBe(true);
    expect(re.test('com.example.build.started.1.0.0')).toBe(true);
    expect(re.test('acme.tools.ci.deploy.finished.2.1.0')).toBe(true);
  });
});
