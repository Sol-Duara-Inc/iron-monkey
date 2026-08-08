/**
 * GOLDEN PARITY — the producer/observer congruence gate.
 *
 * The coordinate contract (ratified 2026-08-04) makes `treePath`/`chainRef`
 * the wire binding key, so Iron Monkey's derivation and Conduit's must be
 * byte-identical. The goldens under `tests/fixtures/cdrus-goldens/` are the
 * ratified source→chain-set derivations; their CANONICAL home is
 * `conduit-go/pkg/cdrus/testdata/goldens/` and the copies here are a mirror
 * (see the sync-check below — canonical wins on drift; a canonical that stops
 * matching re-derivation is a ratification-level finding, not a file fix).
 *
 * Each golden names its source document; this suite derives the chain set
 * with IM's `resolveChainTree` and compares chain-for-chain, path-for-path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import {
  resolveChainTree,
  resolveExpressionTree,
  flattenChains,
} from '../../src/workflow/chain-tree.js';
import { validateWorkflow } from '../../src/workflow/parser.js';
import { loadExpressionRegistry } from '../../src/expressions/loader.js';
import { compareFixtureTrees } from '../../bench/lib.js';
import type { ResolvedChain } from '../../src/workflow/chain-tree.js';
import type { ExpressionBundle } from '../../src/expressions/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../fixtures/cdrus-goldens');
const SOURCES = path.join(FIXTURES, 'sources');
const GOLDENS = path.join(FIXTURES, 'goldens');

/** The golden file's chain shape. */
interface GoldenChain {
  chainRef: string;
  role: string;
  parentChainRef: string | null;
  spawningEventPath: string | null;
  expectedEvents: { treePath: string; event: string; order: number }[];
}
interface GoldenFile {
  source: string;
  chains: GoldenChain[];
}

/** Maps a resolved tree into golden shape via the shared chain walker. */
function toGoldenShape(root: ResolvedChain): GoldenChain[] {
  return flattenChains(root).map((c) => ({
    chainRef: c.chainRef,
    role: c.role,
    parentChainRef: c.parentChainRef ?? null,
    spawningEventPath: c.anchorPath ?? null,
    expectedEvents: c.events.map((e) => ({
      treePath: e.treePath,
      event: e.type,
      order: e.order,
    })),
  }));
}

/** Derives the chain set for a golden's source document. */
async function derive(sourceFile: string): Promise<GoldenChain[]> {
  const registry = loadExpressionRegistry(SOURCES);
  const sourcePath = path.join(SOURCES, sourceFile);

  if (sourceFile.endsWith('.workflow.yaml')) {
    const wf = await validateWorkflow(sourcePath);
    return toGoldenShape(resolveChainTree(wf, registry));
  }

  // Expression-rooted derivation (RFC §6.2) via the first-class API.
  const doc = yaml.load(readFileSync(sourcePath, 'utf-8')) as ExpressionBundle;
  return toGoldenShape(resolveExpressionTree(doc, registry));
}

const goldenFiles = readdirSync(GOLDENS).filter((f) => f.endsWith('.chains.json'));

describe('golden parity — IM derivation vs ratified chain sets', () => {
  it('has goldens to check', () => {
    expect(goldenFiles.length).toBeGreaterThan(0);
  });

  for (const file of goldenFiles) {
    it(`derives ${file.replace('.chains.json', '')} byte-identically`, async () => {
      const golden = JSON.parse(readFileSync(path.join(GOLDENS, file), 'utf-8')) as GoldenFile;
      const derived = await derive(golden.source);

      const derivedByRef = new Map(derived.map((c) => [c.chainRef, c]));
      expect([...derivedByRef.keys()].sort()).toEqual(golden.chains.map((c) => c.chainRef).sort());

      for (const goldenChain of golden.chains) {
        const chain = derivedByRef.get(goldenChain.chainRef);
        expect(chain, `chain ${goldenChain.chainRef} missing from derivation`).toBeDefined();
        expect(chain, `chain ${goldenChain.chainRef}`).toEqual(goldenChain);
      }
    });
  }
});

// ── mirror sync-check ─────────────────────────────────────────────────────────
// Canonical home: conduit-go/pkg/cdrus/testdata. Runs only when that repo is
// present (developer machines); CI without conduit-go skips. On drift the
// mechanical resolution is "canonical wins" — update this mirror, never edit
// the mirror to disagree with canonical.

const CANONICAL = process.env.CONDUIT_GO_TESTDATA
  ? path.resolve(process.env.CONDUIT_GO_TESTDATA)
  : path.join(process.env.HOME ?? '', 'IdeaProjects/conduit-go/pkg/cdrus/testdata');

describe.skipIf(!existsSync(CANONICAL))('golden mirror sync-check (canonical: conduit-go)', () => {
  const entries = existsSync(CANONICAL) ? compareFixtureTrees(CANONICAL, SOURCES, GOLDENS) : [];
  const drift = (subset: typeof entries) =>
    subset.filter((e) => e.status !== 'identical').map((e) => `${e.file}: ${e.status}`);

  it('mirrors every canonical source byte-for-byte', () => {
    const sources = entries.filter((e) => !e.file.startsWith('goldens/'));
    expect(sources.length).toBeGreaterThan(0);
    expect(
      drift(sources),
      `mirror out of sync — copy from canonical:\n${drift(sources).join('\n')}`,
    ).toEqual([]);
  });

  it('mirrors every canonical golden byte-for-byte', () => {
    const goldens = entries.filter((e) => e.file.startsWith('goldens/'));
    expect(goldens.length).toBeGreaterThan(0);
    expect(
      drift(goldens),
      `mirror out of sync — copy from canonical:\n${drift(goldens).join('\n')}`,
    ).toEqual([]);
  });
});
