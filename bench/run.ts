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
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  parseBootLog,
  evaluateSkips,
  evaluateGates,
  assertIdenticalSiblings,
  compareFixtureTrees,
  composeVerdict,
} from './lib.js';
import type { BootSignals } from './lib.js';

const IM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONDUIT_DIR =
  process.env.CONDUIT_GO_DIR ?? path.join(os.homedir(), 'IdeaProjects/conduit-go');
const CANONICAL = path.join(CONDUIT_DIR, 'pkg/cdrus/testdata');
const MIRROR = path.join(IM_ROOT, 'tests/fixtures/cdrus-goldens');
const SUITE_FILE = 'tests/contract/sympraxis.contract.test.ts';
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
  ports?: { engine: number; http: number; grpc: number };
  instanceId?: string;
  facts: Record<string, string>;
  discrepancies: string[];
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function artifact(round: Round, name: string, content: string): void {
  writeFileSync(path.join(round.dir, name), content.endsWith('\n') ? content : `${content}\n`);
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

async function fail(round: Round, reason: string): Promise<never> {
  const teardownNote = await teardown(round);
  artifact(round, 'round.verdict', composeVerdict('RED', reason, round.facts));
  writeReport(round, 'RED', reason, teardownNote);
  console.error(`\nROUND RED — ${reason}\nround dir: ${round.dir}`);
  process.exit(1);
}

function writeReport(round: Round, color: string, reason: string, teardownNote: string): void {
  const lines = [
    `# Contract bench round — ${color}`,
    '',
    `- **Round dir**: ${round.dir}`,
    `- **conduit-go**: ${round.facts.sha ?? 'unrecorded'}${round.facts.dirty === 'true' ? ' (DIRTY)' : ''}`,
    `- **Suite blob**: ${round.facts.suiteSha ?? 'unrecorded'}${round.facts.suiteDirty === 'true' ? ' (DIRTY)' : ''}`,
    `- **instanceId**: ${round.instanceId ?? 'never captured'}`,
    `- **Byte-copy**: ${round.facts.bytecopy ?? 'not run'}`,
    `- **Gates**: ${round.facts.gates ?? 'not run'}`,
    `- **Identical-siblings**: ${round.facts.siblings ?? 'not run'}`,
    `- **Verdict**: ${color} — ${reason}`,
    `- **Teardown**: ${teardownNote}`,
    '',
    '## Discrepancies (brief vs observed)',
    ...(round.discrepancies.length ? round.discrepancies.map((d) => `- ${d}`) : ['- none']),
    '',
    '## Dispositions observed',
    '- bench-level calls observed register 200s only; suite-level dispositions are in suite.verbose.log',
    '',
    `Judge: ${process.env.BENCH_JUDGE ? 'requested but not enabled in this build' : 'not enabled'}`,
  ];
  artifact(round, 'report.md', lines.join('\n'));
}

async function main(): Promise<void> {
  // Round directory (timestamped; SHA appended to facts once known).
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const roundsRoot = process.env.BENCH_ROUNDS_DIR ?? path.join(IM_ROOT, 'bench/rounds');
  const round: Round = { dir: path.join(roundsRoot, stamp), facts: {}, discrepancies: [] };
  mkdirSync(path.join(round.dir, 'register'), { recursive: true });
  mkdirSync(path.join(round.dir, 'bin'), { recursive: true });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void fail(round, `interrupted (${sig})`);
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
      await fail(
        round,
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
    await fail(round, `byte-copy gate: ${divergent.length} fixture(s) not identical to canonical`);
  }

  // §3.3 Build conduitd from the pinned checkout.
  const bin = path.join(round.dir, 'bin/conduitd');
  try {
    execFileSync('go', ['build', '-o', bin, './cmd/conduitd'], { cwd: CONDUIT_DIR });
  } catch (err) {
    await fail(round, `go build failed: ${(err as Error).message}`);
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
  }).catch(async (err: Error) => {
    await fail(round, `boot: ${err.message}`);
    throw err; // unreachable — fail() exits
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
  if (!skipVerdict.ok) await fail(round, `catalog contract: ${skipVerdict.reason}`);

  // Health = a real register, per workflow; instanceId must match the boot log.
  const base = `http://localhost:${engine}`;
  const register = async (workflowId: string): Promise<Record<string, unknown>> => {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200) throw new Error(`register ${workflowId} → HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };

  let fanoutRegister: Record<string, unknown> = {};
  try {
    for (const workflowId of [WORKFLOW_ID, FANOUT_ID]) {
      const body = await register(workflowId);
      artifact(round, `register/${workflowId}.json`, JSON.stringify(body, null, 2));
      if (body.instanceId !== round.instanceId) {
        await fail(
          round,
          `authority mismatch: boot ${round.instanceId} vs register ${String(body.instanceId)}`,
        );
      }
      if (workflowId === FANOUT_ID) fanoutRegister = body;
    }
  } catch (err) {
    await fail(round, `health register: ${(err as Error).message}`);
  }

  // §5 convergence detail: identical siblings disambiguated structurally.
  const siblings = assertIdenticalSiblings(fanoutRegister, 'p1.d0', 'p1.d1');
  round.facts.siblings = siblings.ok ? 'pass' : `FAIL (${siblings.reason})`;
  if (!siblings.ok) await fail(round, `identical-siblings: ${siblings.reason}`);

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
        SYMPRAXIS_BASE_URL: base,
        SYMPRAXIS_WORKFLOW_ID: WORKFLOW_ID,
        SYMPRAXIS_FANOUT_WORKFLOW_ID: FANOUT_ID,
        SYMPRAXIS_INGEST: '1',
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
    await fail(round, 'suite JSON report missing/unparsable — round has no adjudicable record');
  }
  const gateVerdict = evaluateGates(suiteJson, GATE_TITLES);
  artifact(
    round,
    'gates.verdict',
    JSON.stringify({ ...gateVerdict, siblings, instanceId: round.instanceId }, null, 2),
  );
  round.facts.gates = gateVerdict.ok ? 'executed+passed (2/2)' : 'FAIL';
  if (!gateVerdict.ok) await fail(round, `gates: ${gateVerdict.reason}`);

  // Round-envelope authority stability: one more register after the suite.
  try {
    const post = await register(WORKFLOW_ID);
    if (post.instanceId !== round.instanceId) {
      await fail(round, `authority changed during round: now ${String(post.instanceId)}`);
    }
  } catch (err) {
    await fail(round, `post-suite stability register: ${(err as Error).message}`);
  }

  // §3.9 Teardown by pid; verify ports free; verdict + report.
  const teardownNote = await teardown(round);
  const verdict = composeVerdict('GREEN', 'round converged', {
    sha: `${round.facts.sha}${dirty ? '-dirty' : ''}`,
    gates: '2/2',
    siblings: 'pass',
    suiteExit: String(suiteExit),
    instanceId: round.instanceId ?? '',
  });
  artifact(round, 'round.verdict', verdict);
  writeReport(round, 'GREEN', 'round converged', teardownNote);
  console.log(`\nROUND GREEN — ${round.dir}`);
  console.log(verdict);
}

main().catch((err: Error) => {
  console.error(`bench: unhandled failure: ${err.message}`);
  process.exit(1);
});
