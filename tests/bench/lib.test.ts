/**
 * Unit tests for the contract bench's pure core (bench/lib.ts). The live
 * round needs Go + a conduit-go checkout and never runs in CI; these tests
 * make sure the logic that decides a round's COLOR is itself verified —
 * especially §5's collect ≠ execute rule and the identical-siblings check.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  parseBootLog,
  evaluateSkips,
  evaluateGates,
  assertIdenticalSiblings,
  compareFixtureTrees,
  composeVerdict,
  renderReport,
  evaluateCallbackGate,
  shortestTtlMs,
} from '../../bench/lib.js';

const BOOT_LOG = `2026/08/07 22:27:43 engine: catalog skip (name hints): /repo/pkg/cdrus/testdata/acme.tester.nightly-build.expression.yaml
2026/08/07 22:27:43 engine: catalog loaded from /repo/pkg/cdrus/testdata (4 workflows)
2026/08/07 22:27:43 engine: Proleptic protocol listening on :8092 as conduitd:dadisi@host:85360:92b4a491 (witness socket EMPTY — dev boundary)
2026/08/07 22:27:43 conduit: community edition (plain RBAC), HTTP gateway on :8082`;

describe('parseBootLog', () => {
  it('extracts instanceId, port, catalog count, and skips', () => {
    const s = parseBootLog(BOOT_LOG);
    expect(s.instanceId).toBe('conduitd:dadisi@host:85360:92b4a491');
    expect(s.port).toBe(8092);
    expect(s.workflows).toBe(4);
    expect(s.catalogDir).toBe('/repo/pkg/cdrus/testdata');
    expect(s.skips).toHaveLength(1);
  });

  it('returns empty signals for a log with no matches', () => {
    const s = parseBootLog('garbage\nnothing here');
    expect(s.instanceId).toBeUndefined();
    expect(s.skips).toEqual([]);
  });
});

describe('evaluateSkips — exactly one expected skip', () => {
  const EXPECTED = 'acme.tester.nightly-build.expression.yaml';

  it('passes on exactly the dedicated violating fixture', () => {
    expect(evaluateSkips([`/x/${EXPECTED}`], EXPECTED).ok).toBe(true);
  });

  it('fails on zero skips (fixture missing = skip path unproven)', () => {
    const v = evaluateSkips([], EXPECTED);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/saw none/);
  });

  it('fails on extra skips (catalog contract breach)', () => {
    const v = evaluateSkips([`/x/${EXPECTED}`, '/x/other.expression.yaml'], EXPECTED);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/saw 2/);
  });

  it('fails on a single but WRONG skip', () => {
    const v = evaluateSkips(['/x/unexpected.expression.yaml'], EXPECTED);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/unexpected skip/);
  });
});

describe('evaluateGates — §5 collect ≠ execute', () => {
  const suite = (primary: string, fanout: string, success = true) => ({
    success,
    testResults: [
      {
        assertionResults: [
          { fullName: 'x machine gate … (primary)', status: primary },
          { fullName: 'x machine gate … (fanout)', status: fanout },
          { fullName: 'unrelated test', status: 'passed' },
        ],
      },
    ],
  });
  const TITLES = ['(primary)', '(fanout)'];

  it('passes only when both gates EXECUTED and passed', () => {
    expect(evaluateGates(suite('passed', 'passed'), TITLES).ok).toBe(true);
  });

  it('fails when the fanout gate was SKIPPED even though the suite is green', () => {
    const v = evaluateGates(suite('passed', 'skipped'), TITLES);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/\(fanout\) \[skipped\]/);
  });

  it('fails when a gate never collected at all', () => {
    const v = evaluateGates({ success: true, testResults: [] }, TITLES);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not-found/);
  });

  it('fails when the suite itself failed, regardless of gates', () => {
    expect(evaluateGates(suite('passed', 'passed', false), TITLES).ok).toBe(false);
  });

  it('tolerates malformed reporter output', () => {
    expect(evaluateGates(null, TITLES).ok).toBe(false);
    expect(evaluateGates('junk', TITLES).ok).toBe(false);
  });
});

describe('assertIdenticalSiblings — disambiguated structurally, never by content', () => {
  const chain = (ref: string, chainId: string, prefix = ref) => ({
    chainRef: ref,
    chainId,
    role: 'detached',
    expectedEvents: [
      { type: 'dev.cdevents.artifact.signed', order: 0, treePath: `${prefix}.p0` },
      { type: 'dev.cdevents.testoutput.published', order: 1, treePath: `${prefix}.p1` },
    ],
  });

  it('passes for identical events with distinct chainIds and treePaths', () => {
    const body = { chains: [chain('p1.d0', 'id-a'), chain('p1.d1', 'id-b')] };
    expect(assertIdenticalSiblings(body, 'p1.d0', 'p1.d1').ok).toBe(true);
  });

  it('fails when siblings share a chainId (merged by content)', () => {
    const body = { chains: [chain('p1.d0', 'same-id'), chain('p1.d1', 'same-id')] };
    const v = assertIdenticalSiblings(body, 'p1.d0', 'p1.d1');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/share a chainId/);
  });

  it('fails when a sibling is missing from the register', () => {
    const body = { chains: [chain('p1.d0', 'id-a')] };
    expect(assertIdenticalSiblings(body, 'p1.d0', 'p1.d1').ok).toBe(false);
  });

  it('fails when the fixture stops being content-identical', () => {
    const a = chain('p1.d0', 'id-a');
    const b = chain('p1.d1', 'id-b');
    b.expectedEvents[1] = { type: 'dev.cdevents.change.created', order: 1, treePath: 'p1.d1.p1' };
    expect(assertIdenticalSiblings({ chains: [a, b] }, 'p1.d0', 'p1.d1').ok).toBe(false);
  });

  it('fails when a sibling is not role detached', () => {
    const a = chain('p1.d0', 'id-a');
    const b = { ...chain('p1.d1', 'id-b'), role: 'blocking' };
    expect(assertIdenticalSiblings({ chains: [a, b] }, 'p1.d0', 'p1.d1').ok).toBe(false);
  });
});

describe('compareFixtureTrees — canonical enumerates, mirror answers', () => {
  function makeTree(): { canonical: string; sources: string; goldens: string } {
    const root = path.join(
      os.tmpdir(),
      `bench-bytecopy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const canonical = path.join(root, 'canonical');
    const sources = path.join(root, 'mirror/sources');
    const goldens = path.join(root, 'mirror/goldens');
    mkdirSync(path.join(canonical, 'goldens'), { recursive: true });
    mkdirSync(sources, { recursive: true });
    mkdirSync(goldens, { recursive: true });
    return { canonical, sources, goldens };
  }

  it('reports identical, drift, and missing-mirror per file', () => {
    const t = makeTree();
    writeFileSync(path.join(t.canonical, 'same.yaml'), 'a: 1\n');
    writeFileSync(path.join(t.sources, 'same.yaml'), 'a: 1\n');
    writeFileSync(path.join(t.canonical, 'drifted.yaml'), 'a: 1\n');
    writeFileSync(path.join(t.sources, 'drifted.yaml'), 'a: 2\n');
    writeFileSync(path.join(t.canonical, 'only-canonical.yaml'), 'a: 1\n');
    writeFileSync(path.join(t.canonical, 'goldens/g.chains.json'), '{}');
    writeFileSync(path.join(t.goldens, 'g.chains.json'), '{}');

    const report = compareFixtureTrees(t.canonical, t.sources, t.goldens);
    const byFile = new Map(report.map((e) => [e.file, e.status]));
    expect(byFile.get('same.yaml')).toBe('identical');
    expect(byFile.get('drifted.yaml')).toBe('drift');
    expect(byFile.get('only-canonical.yaml')).toBe('missing-mirror');
    expect(byFile.get('goldens/g.chains.json')).toBe('identical');
  });
});

describe('composeVerdict', () => {
  it('renders the one-line verdict with facts', () => {
    const line = composeVerdict('GREEN', 'round converged', { sha: 'abc123', gates: '2/2' });
    expect(line).toBe('GREEN round converged | sha=abc123 gates=2/2');
  });

  it('omits the facts separator when there are none', () => {
    expect(composeVerdict('RED', 'boot failed', {})).toBe('RED boot failed');
  });
});

describe('renderReport — pure §9 report rendering', () => {
  const base = {
    color: 'GREEN' as const,
    reason: 'round converged',
    roundDir: '/rounds/x',
    facts: {
      sha: 'abc123',
      dirty: 'false',
      bytecopy: 'identical (17 files)',
      gates: 'executed+passed (2/2)',
    },
    instanceId: 'conduitd:u@h:1:aa',
    discrepancies: [],
    teardownNote: 'pid 5 terminated; engine port free: true',
    judgeRequested: false,
  };

  it('renders the green report with facts and teardown', () => {
    const md = renderReport(base);
    expect(md).toContain('# Contract bench round — GREEN');
    expect(md).toContain('**conduit-go**: abc123');
    expect(md).toContain('**Gates**: executed+passed (2/2)');
    expect(md).toContain('- none');
    expect(md).toContain('Judge: not enabled');
  });

  it('marks dirty trees and lists discrepancies on a red round', () => {
    const md = renderReport({
      ...base,
      color: 'RED',
      reason: 'gates: fanout skipped',
      facts: { ...base.facts, dirty: 'true', suiteDirty: 'true', suiteSha: 'def456' },
      discrepancies: ['suite has uncommitted changes'],
      judgeRequested: true,
    });
    expect(md).toContain('— RED');
    expect(md).toContain('abc123 (DIRTY)');
    expect(md).toContain('def456 (DIRTY)');
    expect(md).toContain('- suite has uncommitted changes');
    expect(md).toContain('requested but not enabled');
  });

  it('renders placeholders when a round died before capturing anything', () => {
    const md = renderReport({
      ...base,
      color: 'RED',
      reason: 'go build failed',
      facts: {},
      instanceId: undefined,
    });
    expect(md).toContain('**conduit-go**: unrecorded');
    expect(md).toContain('**instanceId**: never captured');
    expect(md).toContain('**Gates**: not run');
  });
});

describe('evaluateCallbackGate — breach → callback → detail', () => {
  const base = {
    shortestTtlMs: 5_000,
    breachBudgetMs: 60_000,
    busConfigured: true,
    breachObserved: true,
    inquiryReceived: true,
    backfillObserved: true,
  };

  it('is CLOSED when the whole loop ran', () => {
    const out = evaluateCallbackGate({ ...base, darkProbePassed: true });
    expect(out.status).toBe('closed');
    expect(out.reasons).toEqual([
      'breach observed on the withheld position',
      'inquiry received by the producer',
      'withheld event backfilled into the chain',
      'dark probe: no answer, as required',
    ]);
  });

  it('is NOT-EXERCISED — never green — when no fixture can breach in the budget', () => {
    // The canonical catalog today: 20-minute budgets, unbreachable in a round.
    const out = evaluateCallbackGate({ ...base, shortestTtlMs: 1_200_000 });
    expect(out.status).toBe('not-exercised');
    expect(out.reasons[0]).toMatch(/shortest TTL is 1200000ms.*must be authored in conduit-go/);
  });

  it('is NOT-EXERCISED when the producer has no bus to emit on', () => {
    const out = evaluateCallbackGate({ ...base, busConfigured: false });
    expect(out.status).toBe('not-exercised');
    expect(out.reasons.at(-1)).toMatch(/no bus is configured/);
  });

  it('is NOT-EXERCISED when no breach happened — the classic false green', () => {
    const out = evaluateCallbackGate({ ...base, breachObserved: false });
    expect(out.status).toBe('not-exercised');
    expect(out.reasons[0]).toMatch(/never breached/);
  });

  it('is NOT-EXERCISED when the breach produced no inquiry (no plugin yet)', () => {
    const out = evaluateCallbackGate({ ...base, inquiryReceived: false });
    expect(out.status).toBe('not-exercised');
    expect(out.reasons.at(-1)).toMatch(/IM was never called/);
  });

  it('is BROKEN once the mechanism ran but did not complete', () => {
    // Distinguishing this from not-exercised is the whole point: an inquiry
    // that arrived and led nowhere is a defect, not a missing prerequisite.
    expect(evaluateCallbackGate({ ...base, backfillObserved: false }).status).toBe('broken');
    expect(evaluateCallbackGate({ ...base, darkProbePassed: false }).status).toBe('broken');
  });
});

describe('shortestTtlMs', () => {
  it('finds the smallest declared budget across documents', () => {
    expect(
      shortestTtlMs(['defaults: {timeout_ms: 1200000}', 'a:\n  timeout_ms: 4000\n  x: 1']),
    ).toBe(4000);
  });

  it('is Infinity when nothing declares a budget', () => {
    expect(shortestTtlMs(['workflow:\n  id: x'])).toBe(Infinity);
  });
});

describe('the gate must not blame the breach for a missing fixture', () => {
  it('names the absent fixture instead of reporting "never breached"', () => {
    // Reporting a breach failure when the loop was never ATTEMPTED is the same
    // dishonesty the gate exists to prevent — it would send someone hunting a
    // timing bug that does not exist.
    const out = evaluateCallbackGate({
      shortestTtlMs: 5_000,
      breachBudgetMs: 60_000,
      busConfigured: true,
      workflowAvailable: false,
      breachObserved: false,
      inquiryReceived: false,
      backfillObserved: false,
    });
    expect(out.status).toBe('not-exercised');
    expect(out.reasons.at(-1)).toMatch(/no callback fixture to drive/);
    expect(out.reasons.at(-1)).toMatch(/NOT the same as a breach that failed to fire/);
  });
});
