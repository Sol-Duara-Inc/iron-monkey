/**
 * @module bench/run
 * The contract bench orchestrator — the §3 round protocol of
 * `conduit-go/docs/engine/contract-bench.md`:
 *
 *   pin → byte-copy gate → build → port-isolated boot (parse, don't sleep) →
 *   health-confirm register → suite (byte-unchanged, both gates armed) →
 *   gate-EXECUTION verdict → round directory → pid-scoped teardown.
 *
 * Invocation: `npm run bench` (tsx). Environment:
 *   CONDUIT_GO_DIR        conduit-go checkout (default ~/IdeaProjects/conduit-go)
 *   BENCH_EXPECTED_SHA    when set, the checkout MUST be at this commit, clean
 *   BENCH_ROUNDS_DIR      round output root (default bench/rounds)
 *   BENCH_JUDGE           reserved seam; records "not enabled" today
 *
 * Discipline (§4, learned 2026-08-07): ONE daemon per round, owned by pid —
 * teardown kills exactly that pid on every path; never a name-scoped kill.
 * Ports are probed, never assumed.
 */

import { spawn, execFileSync } from 'child_process';
import { createServer, connect } from 'net';
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'fs';
import path from 'path';
import { load as yamlLoad } from 'js-yaml';
import os from 'os';
import { fileURLToPath } from 'url';
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
} from './lib.js';
import { getExecutionStore } from '../src/execution/store.js';
import { startInquiryServer } from '../src/execution/server.js';
import { createControlPlane } from '../src/execution/control.js';
import { registerRun } from '../src/chain/register.js';
import type { RegisterResult } from '../src/chain/register.js';
import type { BootSignals, CallbackGateResult, CallbackObservations } from './lib.js';

const IM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONDUIT_DIR =
  process.env.CONDUIT_GO_DIR ?? path.join(os.homedir(), 'IdeaProjects/conduit-go');
const CANONICAL = path.join(CONDUIT_DIR, 'pkg/cdrus/testdata');
const MIRROR = path.join(IM_ROOT, 'tests/fixtures/cdrus-goldens');
const SUITE_FILE = 'tests/contract/proleptic.contract.test.ts';
const EXPECTED_SKIP = 'acme.tester.nightly-build.expression.yaml';
const WORKFLOW_ID = process.env.BENCH_WORKFLOW_ID ?? 'prod-api-gateway-production-deploy-gated';
const FANOUT_ID = process.env.BENCH_FANOUT_WORKFLOW_ID ?? 'build-fanout';
const GATE_TITLES = [
  'divergent documents under one workflow id are a red test, not a discovery (primary)',
  'divergent documents under one workflow id are a red test, not a discovery (fanout)',
];

interface Round {
  dir: string;
  daemonPid?: number;
  /** IM's own inquiry server for the callback gate; closed on every exit path. */
  producer?: { close(): Promise<void> };
  ports?: { engine: number; http: number; grpc: number };
  instanceId?: string;
  facts: Record<string, string>;
  discrepancies: string[];
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function artifact(round: Round, name: string, content: string): void {
  // Names may be nested (`callback/trigger.json`); create the parent so a
  // grouped artifact cannot take the whole round down with an ENOENT.
  const target = path.join(round.dir, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content.endsWith('\n') ? content : `${content}\n`);
}

/** Grabs N ephemeral free ports by binding to :0 and releasing. */
async function freePorts(n: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < n; i++) {
    ports.push(
      await new Promise<number>((resolve, reject) => {
        const srv = createServer();
        srv.listen(0, () => {
          const addr = srv.address();
          if (addr && typeof addr === 'object') {
            const port = addr.port;
            srv.close(() => resolve(port));
          } else {
            srv.close(() => reject(new Error('no address')));
          }
        });
      }),
    );
  }
  return ports;
}

/** True when nothing accepts a TCP connection on the port. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: '127.0.0.1' });
    const done = (free: boolean) => {
      sock.destroy();
      resolve(free);
    };
    sock.once('connect', () => done(false));
    sock.once('error', () => done(true));
    sock.setTimeout(1000, () => done(true));
  });
}

async function teardown(round: Round): Promise<string> {
  // The producer is in-process, so it is closed first and unconditionally —
  // a listening socket surviving a red round would wedge the next one.
  if (round.producer) {
    const producer = round.producer;
    round.producer = undefined;
    await producer.close();
  }
  if (!round.daemonPid) return 'no daemon booted';
  const pid = round.daemonPid;
  round.daemonPid = undefined;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return `pid ${pid} already gone`;
  }
  await new Promise((r) => setTimeout(r, 800));
  try {
    process.kill(pid, 0);
    process.kill(pid, 'SIGKILL'); // still alive → force
  } catch {
    /* exited after SIGTERM */
  }
  await new Promise((r) => setTimeout(r, 200));
  const engineFree = round.ports ? await portFree(round.ports.engine) : true;
  return `pid ${pid} terminated; engine port free: ${engineFree}`;
}

/** A red-round outcome thrown by any step; ONE finalize path handles it. */
class RoundFailure extends Error {}

let finalized = false;
let currentRound: Round | undefined;

/**
 * The single exit path for every outcome: teardown by pid, write verdict and
 * report, log, set the process exit code. Guarded against double entry
 * (signal during finalize, failure inside failure).
 */
async function finalize(round: Round, color: 'GREEN' | 'RED', reason: string): Promise<void> {
  if (finalized) return;
  finalized = true;
  const teardownNote = await teardown(round);
  artifact(round, 'round.verdict', composeVerdict(color, reason, round.facts));
  artifact(
    round,
    'report.md',
    renderReport({
      color,
      reason,
      roundDir: round.dir,
      facts: round.facts,
      instanceId: round.instanceId,
      discrepancies: round.discrepancies,
      teardownNote,
      judgeRequested: Boolean(process.env.BENCH_JUDGE),
    }),
  );
  if (color === 'RED') {
    console.error(`\nROUND RED — ${reason}\nround dir: ${round.dir}`);
    process.exitCode = 1;
  }
}

/**
 * Drives the callback loop and returns its verdict.
 *
 * IM's side of the loop is real: an inquiry server with the daemon's control
 * plane, a run triggered over HTTP with an event withheld, and a dark probe.
 * Conduit's side needs its IM plugin, which Conduit owns. The gate therefore
 * OBSERVES rather than assumes — if the breach never produces an inquiry, it
 * says so precisely instead of pretending the loop closed.
 */
async function runCallbackGate(round: Round): Promise<CallbackGateResult> {
  const breachBudgetMs = Number(process.env.BENCH_BREACH_BUDGET_MS ?? 60_000);

  // Which canonical fixture could breach inside the budget? §4 forbids
  // authoring or adapting fixtures here, so if none can, that is a
  // prerequisite for conduit-go to satisfy, not something to work around.
  const workflowYamls = readdirSync(CANONICAL)
    .filter((f) => f.includes('workflow') && f.endsWith('.yaml'))
    .map((f) => readFileSync(path.join(CANONICAL, f), 'utf-8'));
  const shortest = shortestTtlMs(workflowYamls);

  const imConfig = process.env.BENCH_IM_CONFIG;
  const observations: CallbackObservations = {
    shortestTtlMs: shortest,
    breachBudgetMs,
    busConfigured: Boolean(imConfig ?? process.env.IRON_MONKEY_BUS_URL),
    breachObserved: false,
    inquiryReceived: false,
    backfillObserved: false,
  };

  if (shortest > breachBudgetMs) {
    // Stand the producer up anyway and prove it answers: the IM half of the
    // loop is then demonstrably ready, and only the fixture is missing.
    const store = getExecutionStore(); // the runner records HERE
    const [producerPort] = await freePorts(1);
    const inquiries: string[] = [];
    const server = await startInquiryServer({
      store,
      port: producerPort,
      control: createControlPlane({ config: imConfig, logLevel: 'error' }),
      idleTimeoutMs: 0,
      onInquiry: (id) => inquiries.push(id),
    });
    round.producer = server;
    round.facts.producerUrl = server.url;
    const health = await fetch(`${server.url}/healthz`).then((r) => r.json() as Promise<unknown>);
    artifact(round, 'callback/producer.health.json', JSON.stringify(health, null, 2));
    return evaluateCallbackGate(observations);
  }

  // A fixture CAN breach: drive the full loop.
  const store = getExecutionStore(); // the runner records HERE, not in a fresh store
  const [producerPort] = await freePorts(1);
  const inquiries: string[] = [];
  const server = await startInquiryServer({
    store,
    port: producerPort,
    control: createControlPlane({ config: imConfig, logLevel: 'error' }),
    idleTimeoutMs: 0,
    onInquiry: (id) => inquiries.push(id),
  });
  round.producer = server;
  round.facts.producerUrl = server.url;

  // Defaults are the canonical bench fixture and the withhold target Conduit
  // ruled for it (p2 build.finished: p0/p1 emit, the breach fires ~5s later).
  // Point the triggered run at THIS round's engine. Without it the run mints
  // an offline fallback URN, conduitd never hears about it, and nothing can
  // ever breach — which reads as "the loop is broken" when it was never wired.
  const roundConfigPath = path.join(round.dir, 'callback', 'im-config.json');
  const baseImConfig = imConfig
    ? (JSON.parse(
        JSON.stringify(yamlLoad(readFileSync(imConfig, 'utf-8')) as Record<string, unknown>),
      ) as Record<string, unknown>)
    : {};
  baseImConfig.conduit = { url: `http://127.0.0.1:${round.ports?.engine ?? 0}` };
  mkdirSync(path.dirname(roundConfigPath), { recursive: true });
  writeFileSync(roundConfigPath, JSON.stringify(baseImConfig, null, 2));

  const workflow =
    process.env.BENCH_CALLBACK_WORKFLOW ?? path.join(CANONICAL, 'bench-callback.workflow.yaml');
  const withhold = process.env.BENCH_CALLBACK_WITHHOLD ?? 'build-finished';
  if (!existsSync(workflow)) {
    observations.workflowAvailable = false;
    return evaluateCallbackGate(observations);
  }

  const started = (await (
    await fetch(`${server.url}/api/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflow,
        config: roundConfigPath,
        inject: [`missing:${withhold}`],
      }),
    })
  ).json()) as { executionID?: string };
  artifact(round, 'callback/trigger.json', JSON.stringify(started, null, 2));

  // The babysitter view is keyed by CONDUIT'S chain id, not by IM's
  // executionID. Read it from the STORE, never over HTTP: an HTTP self-call
  // would trip `onInquiry` and the gate would count the harness as Conduit's
  // plugin — reporting a closed loop that nobody outside this process drove.
  let chainId = '';
  for (let i = 0; i < 20 && !chainId; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const found = store.get(started.executionID ?? '');
    if (found.outcome === 'found' && found.record.manifest.chainIdSource === 'conduit') {
      chainId = found.record.manifest.chainId;
    }
  }
  observations.chainId = chainId;
  artifact(round, 'callback/chain.json', JSON.stringify({ chainId }, null, 2));

  const deadline = Date.now() + breachBudgetMs;
  while (chainId && Date.now() < deadline && !observations.backfillObserved) {
    await new Promise((r) => setTimeout(r, 1000));
    observations.inquiryReceived = inquiries.length > 0;
    try {
      const view = (await (
        await fetch(`http://127.0.0.1:${round.ports?.engine ?? 0}/api/runs/${chainId}`)
      ).json()) as { status?: string; observedEvents?: { treePath?: string }[] };
      if (view.status === 'breached') observations.breachObserved = true;
      if ((view.observedEvents ?? []).some((e) => e.treePath === withhold)) {
        observations.backfillObserved = true;
      }
    } catch {
      // The babysitter view is not reachable yet; keep waiting inside budget.
    }
  }

  // The no-answer row: a darkened producer must yield nothing at all.
  if (observations.inquiryReceived) {
    await fetch(`${server.url}/api/control/go-dark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: 5 }),
    });
    const darkStatus = await fetch(
      `${server.url}/api/executions/${started.executionID ?? 'x'}`,
    ).then((r) => r.status);
    observations.darkProbePassed = darkStatus >= 500;
    await fetch(`${server.url}/api/control/go-dark`, { method: 'DELETE' });
  }

  artifact(round, 'callback/observations.json', JSON.stringify(observations, null, 2));
  return evaluateCallbackGate(observations);
}

async function main(): Promise<void> {
  // Round directory (timestamped; SHA appended to facts once known).
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const roundsRoot = process.env.BENCH_ROUNDS_DIR ?? path.join(IM_ROOT, 'bench/rounds');
  const round: Round = { dir: path.join(roundsRoot, stamp), facts: {}, discrepancies: [] };
  currentRound = round;
  mkdirSync(path.join(round.dir, 'register'), { recursive: true });
  mkdirSync(path.join(round.dir, 'bin'), { recursive: true });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void finalize(round, 'RED', `interrupted (${sig})`).then(() => process.exit(1));
    });
  }

  // §3.1 Pin conduit-go.
  const sha = git(['rev-parse', 'HEAD'], CONDUIT_DIR);
  const dirty = git(['status', '--porcelain'], CONDUIT_DIR).length > 0;
  round.facts.sha = sha.slice(0, 12);
  round.facts.dirty = String(dirty);
  artifact(round, 'conduit-go.sha', `${sha}${dirty ? '-dirty' : ''}`);
  if (process.env.BENCH_EXPECTED_SHA) {
    if (!sha.startsWith(process.env.BENCH_EXPECTED_SHA) || dirty) {
      throw new RoundFailure(
        `pin mismatch: expected ${process.env.BENCH_EXPECTED_SHA}, at ${sha.slice(0, 12)}${dirty ? '-dirty' : ''}`,
      );
    }
  }

  // Suite citability: byte-unchanged means recorded, and flagged when dirty.
  const suiteSha = git(['hash-object', SUITE_FILE], IM_ROOT);
  const suiteDirty = git(['status', '--porcelain', SUITE_FILE], IM_ROOT).length > 0;
  round.facts.suiteSha = suiteSha.slice(0, 12);
  round.facts.suiteDirty = String(suiteDirty);
  if (suiteDirty)
    round.discrepancies.push('contract suite has uncommitted changes (round not citable as-is)');

  // §3.2 Byte-copy gate — before anything boots.
  const bytecopy = compareFixtureTrees(
    CANONICAL,
    path.join(MIRROR, 'sources'),
    path.join(MIRROR, 'goldens'),
  );
  artifact(
    round,
    'bytecopy.report',
    bytecopy.map((e) => `${e.status.padEnd(14)} ${e.file}`).join('\n'),
  );
  const divergent = bytecopy.filter((e) => e.status !== 'identical');
  round.facts.bytecopy =
    divergent.length === 0 ? `identical (${bytecopy.length} files)` : 'DIVERGENT';
  if (divergent.length > 0) {
    throw new RoundFailure(
      `byte-copy gate: ${divergent.length} fixture(s) not identical to canonical`,
    );
  }

  // §3.3 Build conduitd from the pinned checkout.
  const bin = path.join(round.dir, 'bin/conduitd');
  try {
    execFileSync('go', ['build', '-o', bin, './cmd/conduitd'], { cwd: CONDUIT_DIR });
  } catch (err) {
    throw new RoundFailure(`go build failed: ${(err as Error).message}`);
  }

  // §3.4 Port-isolated boot; parse signals, never sleep-and-hope.
  const [engine, http, grpc] = await freePorts(3);
  round.ports = { engine, http, grpc };
  const baseConfig = JSON.parse(readFileSync(path.join(CONDUIT_DIR, 'config.json'), 'utf-8')) as {
    http_addr?: string;
    grpc_addr?: string;
  };
  baseConfig.http_addr = `:${http}`;
  baseConfig.grpc_addr = `:${grpc}`;
  const configPath = path.join(round.dir, 'bench-config.json');
  writeFileSync(configPath, JSON.stringify(baseConfig, null, 2));

  const bootLogPath = path.join(round.dir, 'daemon.boot.log');
  writeFileSync(bootLogPath, '');
  const daemon = spawn(bin, ['serve', '-config', configPath], {
    env: { ...process.env, CONDUIT_ENGINE_ADDR: `:${engine}`, CONDUIT_CATALOG_DIR: CANONICAL },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  round.daemonPid = daemon.pid;

  let bootBuffer = '';
  const onChunk = (chunk: Buffer): void => {
    bootBuffer += chunk.toString();
    appendFileSync(bootLogPath, chunk);
  };
  daemon.stdout.on('data', onChunk);
  daemon.stderr.on('data', onChunk);

  const signals: BootSignals = await new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error('boot signals not seen within 10s')),
      10_000,
    );
    const poll = setInterval(() => {
      const parsed = parseBootLog(bootBuffer);
      if (parsed.instanceId && parsed.workflows !== undefined) {
        clearTimeout(deadline);
        clearInterval(poll);
        resolve(parsed);
      }
    }, 100);
    daemon.once('exit', (code) => {
      clearTimeout(deadline);
      clearInterval(poll);
      reject(new Error(`daemon exited during boot (code ${code})`));
    });
  }).catch((err: Error) => {
    throw new RoundFailure(`boot: ${err.message}`);
  });

  round.instanceId = signals.instanceId;
  const skipVerdict = evaluateSkips(signals.skips, EXPECTED_SKIP);
  artifact(
    round,
    'catalog.manifest',
    JSON.stringify(
      {
        catalogDir: signals.catalogDir,
        workflows: signals.workflows,
        skips: signals.skips,
        skipVerdict,
        instanceId: signals.instanceId,
        enginePort: signals.port,
      },
      null,
      2,
    ),
  );
  if (!skipVerdict.ok) throw new RoundFailure(`catalog contract: ${skipVerdict.reason}`);

  // Health = a real register, per workflow; instanceId must match the boot
  // log. Uses the SAME production client the manifest builder uses (503
  // redelivery included) — the bench exercises the real acquisition path.
  const base = `http://localhost:${engine}`;
  const register = async (workflowId: string): Promise<RegisterResult> => {
    const result = await registerRun(workflowId, { url: base });
    if (!result) throw new Error(`register ${workflowId}: no daemon answered`);
    return result;
  };

  let fanoutRegister: RegisterResult | undefined;
  try {
    for (const workflowId of [WORKFLOW_ID, FANOUT_ID]) {
      const body = await register(workflowId);
      artifact(round, `register/${workflowId}.json`, JSON.stringify(body, null, 2));
      if (body.instanceId !== round.instanceId) {
        throw new RoundFailure(
          `authority mismatch: boot ${round.instanceId} vs register ${String(body.instanceId)}`,
        );
      }
      if (workflowId === FANOUT_ID) fanoutRegister = body;
    }
  } catch (err) {
    throw new RoundFailure(`health register: ${(err as Error).message}`);
  }

  // §5 convergence detail: identical siblings disambiguated structurally.
  const siblings = assertIdenticalSiblings(fanoutRegister, 'p1.d0', 'p1.d1');
  round.facts.siblings = siblings.ok ? 'pass' : `FAIL (${siblings.reason})`;
  if (!siblings.ok) throw new RoundFailure(`identical-siblings: ${siblings.reason}`);

  // §3.5 Run the suite byte-unchanged, both gates armed.
  const suiteJsonPath = path.join(round.dir, 'suite.json');
  const verboseLogPath = path.join(round.dir, 'suite.verbose.log');
  const suite = spawn(
    'npm',
    [
      'run',
      'test:contract',
      '--',
      '--reporter=verbose',
      '--reporter=json',
      `--outputFile.json=${suiteJsonPath}`,
    ],
    {
      cwd: IM_ROOT,
      env: {
        ...process.env,
        PROLEPTIC_BASE_URL: base,
        PROLEPTIC_WORKFLOW_ID: WORKFLOW_ID,
        PROLEPTIC_FANOUT_WORKFLOW_ID: FANOUT_ID,
        PROLEPTIC_INGEST: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  writeFileSync(verboseLogPath, '');
  suite.stdout.on('data', (c: Buffer) => appendFileSync(verboseLogPath, c));
  suite.stderr.on('data', (c: Buffer) => appendFileSync(verboseLogPath, c));
  const suiteExit: number = await new Promise((resolve) =>
    suite.once('exit', (c) => resolve(c ?? 1)),
  );
  round.facts.suiteExit = String(suiteExit);

  // §3.6 Gate-EXECUTION verdict (collect ≠ execute).
  let suiteJson: unknown = {};
  try {
    suiteJson = JSON.parse(readFileSync(suiteJsonPath, 'utf-8'));
  } catch {
    throw new RoundFailure(
      'suite JSON report missing/unparsable — round has no adjudicable record',
    );
  }
  const gateVerdict = evaluateGates(suiteJson, GATE_TITLES);
  artifact(
    round,
    'gates.verdict',
    JSON.stringify({ ...gateVerdict, siblings, instanceId: round.instanceId }, null, 2),
  );
  round.facts.gates = gateVerdict.ok ? 'executed+passed (2/2)' : 'FAIL';
  if (!gateVerdict.ok) throw new RoundFailure(`gates: ${gateVerdict.reason}`);

  // §3.7 The callback gate: breach -> callback -> detail, as ONE verdict.
  //
  // Every piece of this loop is already proven in isolation on both sides;
  // nothing tests the SEAM. And the seam has a specific way of faking a pass:
  // if the run finishes before its TTL expires, no breach happens, no
  // callback fires, and a naive "nothing failed" reading calls that green.
  // So the gate checks in causal order and reports NOT-EXERCISED — never
  // green — when a prerequisite is missing, naming the prerequisite.
  const callbackVerdict = await runCallbackGate(round);
  artifact(round, 'callback.verdict', JSON.stringify(callbackVerdict, null, 2));
  round.facts.callback =
    callbackVerdict.status === 'closed'
      ? 'closed (breach->callback->detail)'
      : callbackVerdict.status === 'broken'
        ? 'BROKEN'
        : 'not exercised';
  if (callbackVerdict.status === 'broken') {
    throw new RoundFailure(`callback gate: ${callbackVerdict.reasons.at(-1) ?? 'broken'}`);
  }
  if (callbackVerdict.status === 'not-exercised') {
    // Recorded as a discrepancy, so a GREEN round can never be read as proof
    // that the callback works — the report says which prerequisite is missing.
    round.discrepancies.push(`callback gate NOT EXERCISED: ${callbackVerdict.reasons.at(-1)}`);
  }

  // Round-envelope authority stability: one more register after the suite.
  try {
    const post = await register(WORKFLOW_ID);
    if (post.instanceId !== round.instanceId) {
      throw new RoundFailure(`authority changed during round: now ${String(post.instanceId)}`);
    }
  } catch (err) {
    throw new RoundFailure(`post-suite stability register: ${(err as Error).message}`);
  }

  // §3.9 One exit path for success too: teardown, verdict, report.
  await finalize(round, 'GREEN', 'round converged');
  console.log(`\nROUND GREEN — ${round.dir}`);
  console.log(composeVerdict('GREEN', 'round converged', round.facts));
}

main().catch(async (err: Error) => {
  const reason = err instanceof RoundFailure ? err.message : `unhandled failure: ${err.message}`;
  // The round object lives inside main(); when failure escapes before the
  // finalize guard has run, currentRound (set at round creation) lets the
  // catch still produce a red, torn-down, reported round.
  if (currentRound) await finalize(currentRound, 'RED', reason);
  else console.error(`bench: ${reason}`);
  process.exit(process.exitCode ?? 1);
});
