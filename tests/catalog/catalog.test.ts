/**
 * The catalog. These are mostly about what must NOT happen: handing in a
 * workflow path must stay exactly as it was, a catalog reference must never be
 * guessed into a path (or the reverse), and two documents claiming one
 * identity must be refused rather than raced.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { isCatalogRef, parseCatalogRef, CATALOG_SCHEME } from '../../src/catalog/ref.js';
import { loadCatalog, canonicalFileName } from '../../src/catalog/store.js';
import { resolveCatalogRoot } from '../../src/catalog/roots.js';
import {
  resolveWorkflowSource,
  FileWorkflowSource,
  CatalogWorkflowSource,
} from '../../src/workflow/source.js';
import { createLogger, setLogger } from '../../src/logger/index.js';

setLogger(createLogger({ level: 'fatal', format: 'json' }));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'im-catalog-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.IRON_MONKEY_CATALOG;
});

const workflowDoc = (id: string): string =>
  `workflow:\n  id: ${id}\n  group: g\n  author: a\n  name: ${id}\n  cdrus:\n    version: "0.1.0"\n  produces:\n    - event: dev.cdevents.build.started.0.3.0\n`;

const expressionDoc = (group: string, author: string, name: string): string =>
  `group: ${group}\nauthor: ${author}\nexpression: ${name}\nproduces:\n  - event: dev.cdevents.build.started.0.3.0\n`;

describe('the token rule — a path is never a catalog id, and never the reverse', () => {
  it.each([
    './build.yaml',
    'build',
    'build.yaml',
    'catalog',
    'Catalog:thing',
    'CATALOG:thing',
    '/abs/catalog/x.yaml',
    './catalog:shadow',
    'C:/win/path.yaml',
    'notes:draft.yaml',
  ])('treats %s as a PATH', (token) => {
    expect(isCatalogRef(token)).toBe(false);
    expect(resolveWorkflowSource(token, dir)).toBeInstanceOf(FileWorkflowSource);
  });

  it.each(['catalog:build', 'catalog:my-pipeline', 'catalog:g/a/e'])(
    'treats %s as a CATALOG reference',
    (token) => {
      expect(isCatalogRef(token)).toBe(true);
    },
  );

  it('is exactly eight bytes, case-sensitive', () => {
    expect(CATALOG_SCHEME).toBe('catalog:');
    expect(CATALOG_SCHEME.length).toBe(8);
  });

  it("a colon path still works — the reason the rule is not a scheme regex", () => {
    // `notes:draft.yaml` is a legal relative path that Iron Monkey accepts
    // today. A URI-scheme pattern (^[a-z][a-z0-9+.-]*:) would turn it into a
    // hard error, which is a hand-in regression.
    expect(isCatalogRef('notes:draft.yaml')).toBe(false);
  });

  it('escapes a file literally named catalog:… via ./', () => {
    expect(isCatalogRef('./catalog:weird.yaml')).toBe(false);
  });
});

describe('parsing the remainder — validated, never re-interpreted', () => {
  it('reads a workflow id (no slashes)', () => {
    expect(parseCatalogRef('catalog:my-pipeline')).toEqual({ kind: 'workflow', id: 'my-pipeline' });
  });

  it('reads an expression identity (exactly two slashes)', () => {
    expect(parseCatalogRef('catalog:grp/auth/expr')).toEqual({
      kind: 'expression',
      id: 'grp/auth/expr',
    });
  });

  it.each([
    'catalog:',
    'catalog:./x',
    'catalog:../etc/passwd',
    'catalog:build.yaml',
    'catalog:Build',
    'catalog:a/b',
    'catalog:a/b/c/d',
    'catalog:9lives',
  ])('REFUSES %s instead of falling back to a path', (token) => {
    expect(() => parseCatalogRef(token)).toThrow(/malformed catalog reference/);
  });

  it('refuses an expression identity where a workflow is wanted', () => {
    expect(() => resolveWorkflowSource('catalog:g/a/e', dir)).toThrow(/names an expression/);
  });
});

describe('the store — identity comes from the body', () => {
  it('indexes both kinds from one directory, by declared identity', () => {
    writeFileSync(path.join(dir, 'wf-one.workflow.yaml'), workflowDoc('wf-one'));
    writeFileSync(path.join(dir, 'g.a.e.expression.yaml'), expressionDoc('g', 'a', 'e'));
    const cat = loadCatalog(dir);
    expect(cat.list().map((e) => `${e.kind}:${e.id}`).sort()).toEqual([
      'expression:g/a/e',
      'workflow:wf-one',
    ]);
  });

  it('believes the BODY, not the filename', () => {
    // A file named for one identity declaring another is a lie the filename
    // tells. Indexing by filename would believe it.
    writeFileSync(path.join(dir, 'wrong-name.workflow.yaml'), workflowDoc('real-id'));
    const cat = loadCatalog(dir);
    expect(cat.list()[0].id).toBe('real-id');
    expect(cat.list()[0].misnamed).toBe(true);
    expect(cat.resolve('workflow', 'real-id')).toContain('wrong-name.workflow.yaml');
    expect(() => cat.resolve('workflow', 'wrong-name')).toThrow(/unknown workflow/);
  });

  it('ignores files without the catalog suffix — the suffix is the opt-in', () => {
    writeFileSync(path.join(dir, 'notes.yaml'), workflowDoc('not-an-entry'));
    writeFileSync(path.join(dir, 'README.md'), 'hello');
    expect(loadCatalog(dir).list()).toHaveLength(0);
  });

  it('REFUSES an identity two files claim, naming both', () => {
    writeFileSync(path.join(dir, 'a.workflow.yaml'), workflowDoc('twin'));
    writeFileSync(path.join(dir, 'b.workflow.yaml'), workflowDoc('twin'));
    const cat = loadCatalog(dir);
    expect(() => cat.resolve('workflow', 'twin')).toThrow(/ambiguous workflow 'twin'/);
    expect(cat.conflicts()).toHaveLength(1);
    // An ambiguous identity is not offered for selection either.
    expect(cat.list()).toHaveLength(0);
  });

  it('never throws at INDEX time, only at lookup', () => {
    // loadExpressionRegistry runs on every run. A catalog that failed loudly
    // at load would let one bad file break a pure hand-in run.
    writeFileSync(path.join(dir, 'broken.workflow.yaml'), ':\n  not: [valid');
    writeFileSync(path.join(dir, 'fine.workflow.yaml'), workflowDoc('fine'));
    const cat = loadCatalog(dir);
    expect(cat.problems()).toHaveLength(1);
    expect(cat.resolve('workflow', 'fine')).toContain('fine.workflow.yaml');
  });

  it('is empty, not fatal, when the directory does not exist', () => {
    const cat = loadCatalog(path.join(dir, 'nope'));
    expect(cat.list()).toHaveLength(0);
    expect(() => cat.resolve('workflow', 'x')).toThrow(/unknown workflow/);
  });

  it('names canonical filenames for both kinds', () => {
    expect(canonicalFileName('workflow', 'my-wf')).toBe('my-wf.workflow.yaml');
    expect(canonicalFileName('expression', 'g/a/e')).toBe('g.a.e.expression.yaml');
  });
});

describe('root resolution — ONE root, in a fixed order', () => {
  it('prefers the flag over the environment', () => {
    process.env.IRON_MONKEY_CATALOG = '/from/env';
    expect(resolveCatalogRoot({ flag: '/from/flag' })).toMatchObject({ source: 'flag' });
  });

  it('prefers the environment over config', () => {
    process.env.IRON_MONKEY_CATALOG = '/from/env';
    const r = resolveCatalogRoot({ configured: '/from/config' });
    expect(r.source).toBe('env');
    expect(r.dir).toBe(path.resolve('/from/env'));
  });

  it('falls back to config, then to the bundled corpus', () => {
    expect(resolveCatalogRoot({ configured: '/from/config' }).source).toBe('config');
    expect(resolveCatalogRoot({}).source).toBe('bundled');
  });
});

describe('the resolver — a catalog source never touches disk until asked', () => {
  it('constructs without reading the catalog', () => {
    // Construction must be inert: a run that only hands in paths cannot be
    // affected by a catalog that is missing or broken.
    const src = resolveWorkflowSource('catalog:absent', path.join(dir, 'nope'));
    expect(src).toBeInstanceOf(CatalogWorkflowSource);
    expect(src.name).toBe('catalog:absent');
  });

  it('reports the catalog id as its name, not a filename', () => {
    mkdirSync(path.join(dir, 'sub'), { recursive: true });
    expect(resolveWorkflowSource('catalog:thing', dir).name).toBe('catalog:thing');
    expect(resolveWorkflowSource('./some/where.yaml', dir).name).toBe('where.yaml');
  });

  it('fails at getWorkflow when the id is unknown', async () => {
    await expect(resolveWorkflowSource('catalog:absent', dir).getWorkflow()).rejects.toThrow(
      /unknown workflow 'absent'/,
    );
  });
});
