/**
 * @module bench/lib
 * Pure, unit-tested core of the contract bench (see
 * `conduit-go/docs/engine/contract-bench.md`, mirrored decisions in
 * README §Contract bench). The orchestrator (`bench/run.ts`) does the
 * process/network work; everything that can be tested without booting a
 * daemon lives here.
 *
 * The bench is a RIG, not shipped library code: it lives outside `src/`,
 * outside the tsc build, and outside unit-coverage goals — but its brains are
 * tested in `tests/bench/lib.test.ts` so CI exercises the logic that decides
 * a round's color.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';

// ── boot-log parsing (§2 boot contract) ───────────────────────────────────────

/** Signals extracted from a conduitd boot log. */
export interface BootSignals {
  /** Boot-minted authority identity (`conduitd:user@host:pid:boot`). */
  instanceId?: string;
  /** Engine port from the listening line. */
  port?: number;
  /** Catalog directory the daemon reported loading. */
  catalogDir?: string;
  /** Number of workflows the catalog loaded. */
  workflows?: number;
  /** Full paths of every `catalog skip (name hints)` line, in order. */
  skips: string[];
}

const LISTENING_RE = /Proleptic protocol listening on :(\d+) as (\S+)/;
const CATALOG_RE = /catalog loaded from (.+) \((\d+) workflows\)/;
const SKIP_RE = /catalog skip \(name hints\): (.+)$/;

/**
 * Parses a conduitd boot log for the §2 health/identity signals. Tolerant of
 * interleaved noise; last occurrence wins for singular signals.
 */
export function parseBootLog(text: string): BootSignals {
  const signals: BootSignals = { skips: [] };
  for (const line of text.split('\n')) {
    const listening = LISTENING_RE.exec(line);
    if (listening) {
      signals.port = Number(listening[1]);
      signals.instanceId = listening[2];
    }
    const catalog = CATALOG_RE.exec(line);
    if (catalog) {
      signals.catalogDir = catalog[1];
      signals.workflows = Number(catalog[2]);
    }
    const skip = SKIP_RE.exec(line);
    if (skip) signals.skips.push(skip[1].trim());
  }
  return signals;
}

/**
 * §2: EXACTLY ONE skip line is expected — the dedicated hint-violating
 * fixture. Zero (fixture missing) or extra skips (catalog contract breach)
 * are findings that redden the round.
 */
export function evaluateSkips(
  skips: string[],
  expectedBasename: string,
): { ok: boolean; reason: string } {
  if (skips.length === 0) {
    return {
      ok: false,
      reason: `expected exactly one catalog skip (${expectedBasename}); saw none`,
    };
  }
  if (skips.length > 1) {
    return {
      ok: false,
      reason: `expected exactly one catalog skip; saw ${skips.length}: ${skips
        .map((s) => path.basename(s))
        .join(', ')}`,
    };
  }
  const actual = path.basename(skips[0]);
  if (actual !== expectedBasename) {
    return { ok: false, reason: `unexpected skip '${actual}' (expected '${expectedBasename}')` };
  }
  return { ok: true, reason: `one expected skip (${expectedBasename})` };
}

// ── gate-execution verdict (§5: collect ≠ execute) ────────────────────────────

/** Minimal shape of the vitest JSON reporter output the bench relies on. */
interface VitestJson {
  success?: boolean;
  testResults?: { assertionResults?: { title?: string; fullName?: string; status?: string }[] }[];
}

/** One gate's execution verdict. */
export interface GateResult {
  /** The title fragment used to locate the gate test. */
  gate: string;
  /** Reporter status, or 'not-found' when the test never collected. */
  status: string;
  /** True only for an EXECUTED pass — skip/todo/pending/not-found all fail. */
  ok: boolean;
}

/**
 * §5: a green suite is necessary but not sufficient — the machine gates must
 * have EXECUTED and passed. Skipped/todo/missing gates redden the round even
 * when `success` is true.
 */
export function evaluateGates(
  suiteJson: unknown,
  gateTitleFragments: string[],
): { gates: GateResult[]; suiteSuccess: boolean; ok: boolean; reason: string } {
  const parsed = (suiteJson ?? {}) as VitestJson;
  const assertions = (parsed.testResults ?? []).flatMap((r) => r.assertionResults ?? []);

  const gates: GateResult[] = gateTitleFragments.map((fragment) => {
    const hit = assertions.find((a) => (a.fullName ?? a.title ?? '').includes(fragment));
    const status = hit?.status ?? 'not-found';
    return { gate: fragment, status, ok: status === 'passed' };
  });

  const suiteSuccess = parsed.success === true;
  const failedGates = gates.filter((g) => !g.ok);
  const ok = suiteSuccess && failedGates.length === 0;
  const reason = ok
    ? `suite green; ${gates.length}/${gates.length} gates executed and passed`
    : !suiteSuccess
      ? 'suite reported failure'
      : `gate(s) did not execute+pass: ${failedGates.map((g) => `${g.gate} [${g.status}]`).join('; ')}`;
  return { gates, suiteSuccess, ok, reason };
}

// ── identical-siblings assertion (§5 convergence detail) ──────────────────────

/** Minimal register-response chain shape the bench inspects. */
interface RegisterChain {
  chainRef?: string;
  chainId?: string;
  role?: string;
  expectedEvents?: { type?: string; order?: number; treePath?: string }[];
}

/**
 * §5's highest-value assertion: build-fanout's sibling detached chains carry
 * byte-identical event sequences yet MUST be distinct chains — disambiguated
 * by `chainRef`/`chainId`/`treePath`, never merged by content.
 */
export function assertIdenticalSiblings(
  registerBody: unknown,
  refA: string,
  refB: string,
): { ok: boolean; reason: string } {
  const chains = ((registerBody ?? {}) as { chains?: RegisterChain[] }).chains ?? [];
  const a = chains.find((c) => c.chainRef === refA);
  const b = chains.find((c) => c.chainRef === refB);
  if (!a || !b) {
    return { ok: false, reason: `sibling chains ${refA}/${refB} not both present in register` };
  }
  if (a.role !== 'detached' || b.role !== 'detached') {
    return { ok: false, reason: `expected both siblings detached; got ${a.role}/${b.role}` };
  }
  const sig = (c: RegisterChain) =>
    [...(c.expectedEvents ?? [])]
      .sort((x, y) => (x.order ?? 0) - (y.order ?? 0))
      .map((e) => e.type)
      .join('|');
  if (sig(a) !== sig(b)) {
    return { ok: false, reason: 'sibling event sequences differ (fixture no longer identical)' };
  }
  if (!a.chainId || a.chainId === b.chainId) {
    return { ok: false, reason: 'identical siblings share a chainId — merged by content' };
  }
  const paths = (c: RegisterChain) => (c.expectedEvents ?? []).map((e) => e.treePath).join('|');
  if (paths(a) === paths(b)) {
    return { ok: false, reason: 'identical siblings share treePaths — merged by content' };
  }
  return {
    ok: true,
    reason: `${refA}/${refB}: identical events, distinct chainIds and treePaths`,
  };
}

// ── byte-copy pre-flight (§3.2) ───────────────────────────────────────────────

/** One file's byte-copy status. */
export interface ByteCopyEntry {
  file: string;
  status: 'identical' | 'drift' | 'missing-mirror';
}

/**
 * §3.2: every canonical fixture must be byte-identical in the mirror before
 * anything boots. Canonical enumerates; the mirror answers.
 */
export function compareFixtureTrees(
  canonicalDir: string,
  mirrorSourcesDir: string,
  mirrorGoldensDir: string,
): ByteCopyEntry[] {
  const entries: ByteCopyEntry[] = [];
  const compare = (canonicalPath: string, mirrorPath: string, label: string): void => {
    if (!existsSync(mirrorPath)) {
      entries.push({ file: label, status: 'missing-mirror' });
      return;
    }
    const same = readFileSync(canonicalPath, 'utf-8') === readFileSync(mirrorPath, 'utf-8');
    entries.push({ file: label, status: same ? 'identical' : 'drift' });
  };

  for (const f of readdirSync(canonicalDir).filter((n) => n.endsWith('.yaml'))) {
    compare(path.join(canonicalDir, f), path.join(mirrorSourcesDir, f), f);
  }
  const canonicalGoldens = path.join(canonicalDir, 'goldens');
  if (existsSync(canonicalGoldens)) {
    for (const f of readdirSync(canonicalGoldens).filter((n) => n.endsWith('.chains.json'))) {
      compare(path.join(canonicalGoldens, f), path.join(mirrorGoldensDir, f), `goldens/${f}`);
    }
  }
  return entries;
}

// ── round verdict ─────────────────────────────────────────────────────────────

/** Composes the one-line `round.verdict` (§6). */
export function composeVerdict(
  color: 'GREEN' | 'RED',
  reason: string,
  facts: Record<string, string>,
): string {
  const factStr = Object.entries(facts)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return `${color} ${reason}${factStr ? ` | ${factStr}` : ''}`;
}

// ── round report (pure rendering; the orchestrator only writes the file) ──────

/** Everything the round report needs, gathered by the orchestrator. */
export interface ReportInput {
  color: 'GREEN' | 'RED';
  reason: string;
  roundDir: string;
  facts: Record<string, string>;
  instanceId?: string;
  discrepancies: string[];
  teardownNote: string;
  judgeRequested: boolean;
}

/** Renders the §9 report-back markdown for a round. */
export function renderReport(input: ReportInput): string {
  const { color, reason, roundDir, facts, instanceId, discrepancies, teardownNote } = input;
  return [
    `# Contract bench round — ${color}`,
    '',
    `- **Round dir**: ${roundDir}`,
    `- **conduit-go**: ${facts.sha ?? 'unrecorded'}${facts.dirty === 'true' ? ' (DIRTY)' : ''}`,
    `- **Suite blob**: ${facts.suiteSha ?? 'unrecorded'}${facts.suiteDirty === 'true' ? ' (DIRTY)' : ''}`,
    `- **instanceId**: ${instanceId ?? 'never captured'}`,
    `- **Byte-copy**: ${facts.bytecopy ?? 'not run'}`,
    `- **Gates**: ${facts.gates ?? 'not run'}`,
    `- **Identical-siblings**: ${facts.siblings ?? 'not run'}`,
    `- **Verdict**: ${color} — ${reason}`,
    `- **Teardown**: ${teardownNote}`,
    '',
    '## Discrepancies (brief vs observed)',
    ...(discrepancies.length ? discrepancies.map((d) => `- ${d}`) : ['- none']),
    '',
    '## Dispositions observed',
    '- bench-level calls observed register 200s only; suite-level dispositions are in suite.verbose.log',
    '',
    `Judge: ${input.judgeRequested ? 'requested but not enabled in this build' : 'not enabled'}`,
  ].join('\n');
}

// ── The callback gate: breach → callback → detail ────────────────────────────

/** What the round observed while trying to close the callback loop. */
export interface CallbackObservations {
  /** The shortest event TTL found in the canonical catalog, in ms. */
  shortestTtlMs: number;
  /** How long the round is willing to wait for a breach, in ms. */
  breachBudgetMs: number;
  /**
   * A bus is configured for triggered runs. The loop needs IM to actually
   * EMIT — some events arriving and one withheld is what produces a breach —
   * so without a bus there is nothing to breach against.
   */
  busConfigured: boolean;
  /** Conduit's babysitter reported the withheld position breached. */
  /** The callback fixture named for the round exists on disk. */
  workflowAvailable?: boolean;
  /** Conduit's chain id for the triggered run; empty when it never registered. */
  chainId?: string;
  breachObserved: boolean;
  /** IM's endpoint was actually called about the triggered execution. */
  inquiryReceived: boolean;
  /** Conduit ingested the withheld event off the back of the inquiry. */
  backfillObserved: boolean;
  /** A darkened endpoint produced no answer, as the no-answer row requires. */
  darkProbePassed?: boolean;
}

/**
 * The gate's verdict. `not-exercised` is deliberately NOT a pass: the round
 * must never report green in a way that could be read as "the callback
 * works" when the loop never ran. It is also not a failure of the product —
 * it names the missing prerequisite instead, so the round says exactly what
 * is needed to close it.
 */
export interface CallbackGateResult {
  status: 'closed' | 'broken' | 'not-exercised';
  /** One line per reason, in the order they were determined. */
  reasons: string[];
}

/**
 * Evaluates the breach → callback → detail loop.
 *
 * The ordering matters: a breach that never happened cannot be distinguished
 * from a callback that never fired unless the breach is checked FIRST. The
 * classic way to fake a green here is to assert "no failures occurred" on a
 * run that finished before its TTL could expire — so the shortest available
 * TTL is checked before anything else, and a catalog whose budgets are all
 * longer than the round's patience is reported as an unmet prerequisite
 * rather than silently skipped.
 */
export function evaluateCallbackGate(obs: CallbackObservations): CallbackGateResult {
  const reasons: string[] = [];

  if (obs.shortestTtlMs > obs.breachBudgetMs) {
    reasons.push(
      `no canonical fixture can breach within the round budget: shortest TTL is ` +
        `${obs.shortestTtlMs}ms, budget is ${obs.breachBudgetMs}ms — a short-TTL fixture ` +
        `must be authored in conduit-go/pkg/cdrus/testdata (§4 forbids adapting fixtures here)`,
    );
    return { status: 'not-exercised', reasons };
  }

  if (!obs.busConfigured) {
    reasons.push(
      'no bus is configured for triggered runs (set BENCH_IM_CONFIG, or IRON_MONKEY_BUS_URL) — ' +
        'the producer cannot emit, so no position can breach',
    );
    return { status: 'not-exercised', reasons };
  }

  if (obs.workflowAvailable === false) {
    reasons.push(
      'no callback fixture to drive: set BENCH_CALLBACK_WORKFLOW (and _WITHHOLD), or add ' +
        'bench-callback.workflow.yaml to the canonical catalog — the loop was never attempted, ' +
        'which is NOT the same as a breach that failed to fire',
    );
    return { status: 'not-exercised', reasons };
  }

  if (obs.chainId === '') {
    reasons.push(
      'the triggered run never registered with the daemon, so no chain exists to breach — ' +
        'check that the round handed the run a conduit URL for THIS round',
    );
    return { status: 'not-exercised', reasons };
  }

  if (!obs.breachObserved) {
    reasons.push(
      'the withheld position never breached — without a breach there is nothing for the ' +
        'callback to answer, so the loop was not exercised',
    );
    return { status: 'not-exercised', reasons };
  }
  reasons.push('breach observed on the withheld position');

  if (!obs.inquiryReceived) {
    reasons.push(
      'the breach did not produce an inquiry: IM was never called. The IM plugin is ' +
        "Conduit's to own — until it is configured, the loop cannot close",
    );
    return { status: 'not-exercised', reasons };
  }
  reasons.push('inquiry received by the producer');

  // Past this point the mechanism DID run, so anything wrong is a real break.
  if (!obs.backfillObserved) {
    reasons.push(
      'the inquiry was answered but the withheld event was never ingested — the answer ' +
        'did not translate into a backfill',
    );
    return { status: 'broken', reasons };
  }
  reasons.push('withheld event backfilled into the chain');

  if (obs.darkProbePassed === false) {
    reasons.push('a darkened endpoint still produced an answer — the no-answer row is unproven');
    return { status: 'broken', reasons };
  }
  if (obs.darkProbePassed === true) reasons.push('dark probe: no answer, as required');

  return { status: 'closed', reasons };
}

/**
 * The shortest event TTL declared across a set of workflow documents. The
 * callback gate needs a fixture that can breach inside a round; this is how
 * the round discovers whether one exists. `Infinity` when none declare any.
 */
export function shortestTtlMs(workflowYamls: string[]): number {
  let shortest = Infinity;
  for (const text of workflowYamls) {
    for (const match of text.matchAll(/timeout_ms:\s*(\d+)/g)) {
      shortest = Math.min(shortest, Number(match[1]));
    }
  }
  return shortest;
}
