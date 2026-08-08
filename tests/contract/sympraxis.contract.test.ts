/**
 * Sympraxis Chain-Declaration Protocol — CONTRACT / ACCEPTANCE TESTS
 * ==================================================================
 *
 * Audience: the engineer implementing the Sympraxis control plane (Junction
 * Box / Conduit / Legion). These are BLACK-BOX HTTP conformance tests — no
 * assumptions about server internals, only the contract Iron Monkey depends on
 * to emit `detach` / parallel chains.
 *
 * SINGLE SOURCE OF TRUTH: the Proleptic Event Chain Protocol
 * (`cdevents-object-inheritance/reference/proleptic-event-chain-protocol.md`,
 * successor to the Sympraxis Chain-Declaration Protocol of 2026-05-28) plus
 * the coordinate contract ratified 2026-08-04 (axes `p`/`s`/`d`; roles
 * `main`/`blocking`/`detached`; goldens in
 * `conduit-go/pkg/cdrus/testdata/goldens/`). This suite is the executable
 * form; if they disagree, the doc wins and this file is the bug.
 *
 * This is a TDD hand-off: expect FAILURES until Sympraxis implements the doc.
 *
 *   SYMPRAXIS_BASE_URL=https://jb.local \
 *   SYMPRAXIS_WORKFLOW_ID=prod-api-gateway-production-deploy-gated \
 *   npm run test:contract
 *
 * Skips cleanly when SYMPRAXIS_BASE_URL is unset (safe in offline CI).
 *
 * ---------------------------------------------------------------------------
 * THE LOAD-BEARING DECISIONS (see the doc for full normative text)
 * ---------------------------------------------------------------------------
 *  1. Sympraxis is the SOLE authority for chain UUIDs. A client never supplies
 *     a `chainId` — there is no client-mint path.
 *  2. The client mints each event's `context.id` (to wire PATH/RELATION/END
 *     links before emit). Sympraxis associates by `context.chainId`.
 *  3. The binding key is the positional `treePath` (axis-prefixed: `p`=produces,
 *     `d`=detach, e.g. `p1.p1.p0.d0`), NOT the `workflowEventId` slug — slug
 *     dedup-counts diverge across producer/observer exactly on detached chains.
 *     `workflowEventId` rides along as a human label / RELATION target only.
 *  4. Single-originator rule: each chain's `chainRef` is originated by exactly
 *     one side — Sympraxis for YAML chains (returned, never re-derived), the
 *     client for non-YAML chains (its own label).
 *  5. `parentChainId` is structural (returned at register). `parentEventId` is
 *     runtime-discovered: null until the spawning event's RELATION link is
 *     observed at ingestion.
 *  6. YAML is authoritative; conformance is runtime. observed ⊇ expected is
 *     fine (extras never breach); observed ⊊ expected breaches.
 *
 * ENDPOINTS (overridable so the suite targets JB or Conduit):
 *   POST {CHAINS_PATH}            — batch register (body has workflowId) AND
 *                                   late declaration (body has no workflowId)
 *   GET  {CHAINS_PATH}/{chainId}  — babysitter view
 *   POST {EVENTS_PATH}            — CDEvent ingestion (chainId association)
 *
 * FIXTURE REQUIREMENT: SYMPRAXIS_WORKFLOW_ID must name a workflow registered on
 * the instance that contains at least one detached chain (the default is the
 * doc's gated-deploy example). The content-identical-sibling test additionally
 * needs SYMPRAXIS_FANOUT_WORKFLOW_ID → a workflow with >=2 sibling detached
 * chains sharing the same expectedEvents (e.g. a `build-with-async-scan`
 * fan-out). Ingestion tests run only when SYMPRAXIS_INGEST=1.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
// Machine gate (guide v2 §4): the ONE deliberate break in the suite's
// black-box stance — the client compares the server's derivation against
// Iron Monkey's local derivation of the same workflow id. Server internals
// stay opaque; the client's own expectation is the fixture mirror.
import { resolveChainTree, flattenChains } from '../../src/workflow/chain-tree.js';
import { validateWorkflow } from '../../src/workflow/parser.js';
import { loadExpressionRegistry } from '../../src/expressions/loader.js';
import { createLogger, setLogger } from '../../src/logger/index.js';

// ── Configuration ───────────────────────────────────────────────────────────
const BASE_URL = process.env.SYMPRAXIS_BASE_URL;
const TOKEN = process.env.SYMPRAXIS_TOKEN;
const CHAINS_PATH = process.env.SYMPRAXIS_CHAINS_PATH ?? '/api/runs';
const EVENTS_PATH = process.env.SYMPRAXIS_EVENTS_PATH ?? '/api/events';
const EVENTS_STATUS = Number(process.env.SYMPRAXIS_EVENTS_STATUS ?? '202');
const WORKFLOW_ID = process.env.SYMPRAXIS_WORKFLOW_ID ?? 'prod-api-gateway-production-deploy-gated';
const FANOUT_WORKFLOW_ID = process.env.SYMPRAXIS_FANOUT_WORKFLOW_ID;
const REQUIRE_AUTH = process.env.SYMPRAXIS_REQUIRE_AUTH === '1';
const RUN_INGEST = process.env.SYMPRAXIS_INGEST === '1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/;

// ── Protocol shapes ─────────────────────────────────────────────────────────
interface ExpectedEvent {
  type: string;
  treePath?: string;
  order: number;
  workflowEventId?: string;
  timeoutMs: number;
}
interface ChainEntry {
  chainRef: string;
  chainId: string;
  role: string;
  status: string;
  parentChainId: string | null;
  parentChainRef: string | null;
  parentEventId: string | null;
  linkKind: string | null;
  expectedEvents: ExpectedEvent[];
}
interface Resp {
  status: number;
  body: Record<string, unknown>;
}

// ── HTTP helpers (black-box; no Iron Monkey internals imported) ─────────────
function uuid(): string {
  return crypto.randomUUID();
}

function authHeaders(includeAuth = true): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (includeAuth && TOKEN) h['Authorization'] = `Bearer ${TOKEN}`;
  return h;
}

async function parse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { _raw: text };
  }
}

/** POST {CHAINS_PATH} — used for both batch register and late declaration. */
async function postChains(
  body: Record<string, unknown>,
  opts: { idempotencyKey?: string; includeAuth?: boolean } = {},
): Promise<Resp> {
  const headers = authHeaders(opts.includeAuth ?? true);
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const res = await fetch(`${BASE_URL}${CHAINS_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return { status: res.status, body: await parse(res) };
}

async function getChain(chainId: string): Promise<Resp> {
  const res = await fetch(`${BASE_URL}${CHAINS_PATH}/${encodeURIComponent(chainId)}`, {
    method: 'GET',
    headers: authHeaders(),
    signal: AbortSignal.timeout(10000),
  });
  return { status: res.status, body: await parse(res) };
}

async function emitCdEvent(payload: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${BASE_URL}${EVENTS_PATH}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  return res.status;
}

async function pollUntil<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  { timeoutMs = 8000, intervalMs = 300 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!done(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await read();
  }
  return last;
}

// ── Domain helpers ──────────────────────────────────────────────────────────
function chainsOf(body: Record<string, unknown>): ChainEntry[] {
  return (body.chains as unknown as ChainEntry[]) ?? [];
}

function mainChain(chains: ChainEntry[]): ChainEntry | undefined {
  return chains.find((c) => c.role === 'main');
}

/** First non-main chain spawned from somewhere (detached/concurrent side-chain). */
function aDetachedChain(chains: ChainEntry[]): ChainEntry | undefined {
  return chains.find((c) => c.role !== 'main');
}

/** ordered `order:type` signature, used to detect content-identical chains. */
function signatureOf(c: ChainEntry): string {
  return [...c.expectedEvents]
    .sort((a, b) => a.order - b.order)
    .map((e) => `${e.order}:${e.type}`)
    .join('|');
}

/** A minimal CDEvent envelope mirroring Iron Monkey's emitted payload. */
function cdEvent(
  chainId: string,
  type: string,
  links?: Array<Record<string, unknown>>,
  id: string = uuid(),
): Record<string, unknown> {
  return {
    context: {
      specversion: '0.6.0-draft',
      id,
      source: 'iron-monkey/contract-test',
      type,
      timestamp: new Date().toISOString(),
      chainId,
      ...(links ? { links } : {}),
    },
    subject: { id: `subject-${id}`, content: {} },
  };
}

/** Client-supplied expectedEvents for non-YAML (verification / late) chains. */
function declaredEvents(types: string[], timeoutMs = 600000): ExpectedEvent[] {
  return types.map((type, i) => ({ type, order: i, timeoutMs }));
}

/** Asserts the structural invariants every register response must satisfy. */
function assertValidChainSet(body: Record<string, unknown>): {
  main: ChainEntry;
  chains: ChainEntry[];
} {
  expect(String(body.runId)).toMatch(UUID_RE);
  expect(String(body.issuedAt)).toMatch(ISO_RE);
  // instanceId: the daemon's boot-minted authority identity (guide v2 §3).
  expect(String(body.instanceId)).toMatch(/^conduitd:/);

  const chains = chainsOf(body);
  expect(chains.length).toBeGreaterThan(0);

  const mains = chains.filter((c) => c.role === 'main');
  expect(mains, 'exactly one main chain').toHaveLength(1);
  const main = mains[0];
  expect(main.chainRef).toBe('root');
  expect(main.parentChainId).toBeNull();
  expect(main.chainId, 'runId === main chainId').toBe(body.runId);

  const ids = chains.map((c) => c.chainId);
  ids.forEach((id) => expect(String(id)).toMatch(UUID_RE));
  expect(new Set(ids).size, 'chainIds distinct').toBe(ids.length);

  for (const c of chains) {
    // `blocking` is the ratified role for spawn chains; `concurrent` is its
    // pre-ratification name, accepted transitionally.
    expect(['main', 'detached', 'blocking', 'concurrent'], `unknown role '${c.role}'`).toContain(
      c.role,
    );
    // expectedEvents is ALWAYS an array, never null (guide v2 §2) — including
    // chains scoped out by `tool` filtering.
    expect(Array.isArray(c.expectedEvents), `expectedEvents must be an array`).toBe(true);
    for (const e of c.expectedEvents) {
      expect(typeof e.type).toBe('string');
      expect(typeof e.order).toBe('number');
      expect(typeof e.timeoutMs, 'timeoutMs drives breach deadlines').toBe('number');
      expect(typeof e.treePath).toBe('string');
      // Every treePath segment is `<axis><index>` (axis ∈ {p,s,d} — ratified
      // 2026-08-04; the `b` axis is retired). Catches a server returning bare
      // `2.1.0` with no axis prefix — even for main members.
      const segs = String(e.treePath).split('.');
      segs.forEach((seg) =>
        expect(seg, `treePath segment '${seg}' must match <axis><index>`).toMatch(/^[psd]\d+$/),
      );
      // chainRef is a prefix of its members' treePaths (root = no spawn/detach axis).
      if (c.chainRef === 'root') {
        expect(
          segs.some((seg) => seg.startsWith('d') || seg.startsWith('s')),
          `main member ${e.treePath} must have no spawn/detach axis`,
        ).toBe(false);
      } else {
        expect(String(e.treePath).startsWith(c.chainRef)).toBe(true);
      }
    }
    if (c.role !== 'main') {
      expect(String(c.parentChainId)).toMatch(UUID_RE);
      expect(c.parentChainRef).toBeTruthy();
      expect(c.parentEventId, 'parentEventId is runtime-discovered').toBeNull();
    }
  }

  return { main, chains };
}

const RUN = Boolean(BASE_URL);
const describeContract = RUN ? describe : describe.skip;

if (!RUN) {
  console.log('SYMPRAXIS_BASE_URL not set — skipping Sympraxis contract suite.');
}

describeContract('Sympraxis chain-declaration protocol', () => {
  // ── §1 Batch register ──────────────────────────────────────────────────────
  describe('POST {CHAINS_PATH} — batch register', () => {
    it('returns the full minted chain set with valid structure', async () => {
      const res = await postChains({ workflowId: WORKFLOW_ID });
      expect(res.status).toBe(200);
      assertValidChainSet(res.body);
    });

    it('derives at least one detached/parallel chain from the fixture workflow', async () => {
      const res = await postChains({ workflowId: WORKFLOW_ID });
      const detached = aDetachedChain(chainsOf(res.body));
      expect(
        detached,
        `SYMPRAXIS_WORKFLOW_ID='${WORKFLOW_ID}' must contain a detached/parallel chain`,
      ).toBeTruthy();
    });

    it('never honors a client-supplied chainId (Sympraxis is sole authority)', async () => {
      const planted = uuid();
      const res = await postChains({
        workflowId: WORKFLOW_ID,
        chainId: planted,
        verificationList: [
          {
            chainRef: planted, // also planted as a ref-shaped uuid; must not be used as a chainId
            name: 'planted',
            parentChainRef: 'root',
            expectedEvents: declaredEvents(['dev.cdevents.ticket.created.0.2.0']),
          },
        ],
      });
      if (res.status === 200) {
        const allIds = [String(res.body.runId), ...chainsOf(res.body).map((c) => c.chainId)];
        expect(allIds).not.toContain(planted);
      } else {
        expect(res.status).toBe(400);
      }
    });

    it('is idempotent under Idempotency-Key: a retry returns the same chain set', async () => {
      const key = `idem-${uuid()}`;
      const first = await postChains({ workflowId: WORKFLOW_ID }, { idempotencyKey: key });
      const second = await postChains({ workflowId: WORKFLOW_ID }, { idempotencyKey: key });

      expect(first.status).toBe(200);
      expect(second.body.runId).toBe(first.body.runId);

      const firstByRef = new Map(chainsOf(first.body).map((c) => [c.chainRef, c.chainId]));
      for (const c of chainsOf(second.body)) {
        expect(firstByRef.get(c.chainRef)).toBe(c.chainId);
      }
    });
  });

  // ── §1b Verification list reconciliation ──────────────────────────────────
  describe('verification list reconciliation', () => {
    it('confirms a verification entry that matches a YAML chain (no expectedEvents needed)', async () => {
      // Discover a real YAML detached chainRef from a plain register first.
      const seed = await postChains({ workflowId: WORKFLOW_ID });
      const detached = aDetachedChain(chainsOf(seed.body));
      if (!detached) {
        expect.fail(`SYMPRAXIS_WORKFLOW_ID='${WORKFLOW_ID}' needs a detached chain`);
        return;
      }

      const res = await postChains({
        workflowId: WORKFLOW_ID,
        verificationList: [
          {
            chainRef: detached.chainRef,
            name: 'verify-known',
            parentChainRef: detached.parentChainRef,
            // expectedEvents intentionally omitted — YAML is authoritative.
          },
        ],
      });
      expect(res.status).toBe(200);
      const echoed = chainsOf(res.body).find((c) => c.chainRef === detached.chainRef);
      expect(echoed?.status).toBe('confirmed');
    });

    it('grafts an unknown (non-YAML) verification entry with a freshly minted id', async () => {
      const novelRef = `client-novel-${uuid()}`;
      const res = await postChains({
        workflowId: WORKFLOW_ID,
        verificationList: [
          {
            chainRef: novelRef,
            name: 'runtime-extra',
            parentChainRef: 'root',
            linkKind: 'TRIGGER',
            expectedEvents: declaredEvents(['dev.cdevents.service.rolledback.0.3.0']),
          },
        ],
      });
      expect(res.status).toBe(200);
      const added = chainsOf(res.body).find((c) => c.chainRef === novelRef);
      expect(added?.status).toBe('added');
      expect(String(added?.chainId)).toMatch(UUID_RE);
      // parentChainRef 'root' resolves to this response's main chainId.
      const main = mainChain(chainsOf(res.body));
      expect(added?.parentChainId).toBe(main?.chainId);
    });
  });

  // ── §1c Register validation ────────────────────────────────────────────────
  describe('register validation', () => {
    it('rejects a non-YAML verification entry missing expectedEvents with 400', async () => {
      const res = await postChains({
        workflowId: WORKFLOW_ID,
        verificationList: [{ chainRef: `novel-${uuid()}`, name: 'bad', parentChainRef: 'root' }],
      });
      expect(res.status).toBe(400);
    });

    it('rejects a parentChainRef referencing an unknown chain with 400', async () => {
      const res = await postChains({
        workflowId: WORKFLOW_ID,
        verificationList: [
          {
            chainRef: `novel-${uuid()}`,
            name: 'bad-parent',
            parentChainRef: `nope-${uuid()}`,
            expectedEvents: declaredEvents(['dev.cdevents.ticket.created.0.2.0']),
          },
        ],
      });
      expect(res.status).toBe(400);
    });

    it.runIf(REQUIRE_AUTH)('rejects an unauthenticated register with 401', async () => {
      const res = await postChains({ workflowId: WORKFLOW_ID }, { includeAuth: false });
      expect(res.status).toBe(401);
    });
  });

  // ── §1d Content-identical sibling disambiguation (the treePath payoff) ─────
  describe('content-identical sibling chains', () => {
    it.runIf(Boolean(FANOUT_WORKFLOW_ID))(
      'binds siblings with identical expectedEvents by distinct treePath, not by content',
      async () => {
        const res = await postChains({ workflowId: FANOUT_WORKFLOW_ID });
        expect(res.status).toBe(200);
        const chains = chainsOf(res.body);

        const groups = new Map<string, ChainEntry[]>();
        for (const c of chains) {
          const sig = signatureOf(c);
          groups.set(sig, [...(groups.get(sig) ?? []), c]);
        }
        const twins = [...groups.values()].find((g) => g.length >= 2);
        expect(
          twins,
          `SYMPRAXIS_FANOUT_WORKFLOW_ID='${FANOUT_WORKFLOW_ID}' must have >=2 content-identical sibling chains`,
        ).toBeTruthy();
        if (!twins) return;

        const [a, b] = twins;
        expect(signatureOf(a)).toBe(signatureOf(b)); // identical content
        expect(a.chainRef).not.toBe(b.chainRef); // distinct binding keys
        expect(a.chainId).not.toBe(b.chainId); // distinct minted ids
      },
    );
  });

  // ── §2 Late declaration ────────────────────────────────────────────────────
  describe('POST {CHAINS_PATH} — late declaration', () => {
    it('mints a chain for a runtime-discovered (non-YAML) declaration', async () => {
      const reg = await postChains({ workflowId: WORKFLOW_ID });
      const main = mainChain(chainsOf(reg.body));
      expect(main).toBeTruthy();
      if (!main) return;

      const res = await postChains({
        chainRef: `rollback-${uuid()}`,
        name: 'incident-rollback',
        parentChainId: main.chainId,
        linkKind: 'TRIGGER',
        expectedEvents: declaredEvents(['dev.cdevents.service.rolledback.0.3.0']),
      });
      expect(res.status).toBeLessThan(300);
      expect(res.body.status).toBe('added');
      expect(String(res.body.chainId)).toMatch(UUID_RE);
      expect(res.body.parentChainId).toBe(main.chainId);
    });

    it('rejects a late declaration whose parent chain does not exist with 422', async () => {
      const res = await postChains({
        chainRef: `orphan-${uuid()}`,
        name: 'orphan',
        parentChainId: uuid(), // no such chain
        expectedEvents: declaredEvents(['dev.cdevents.service.rolledback.0.3.0']),
      });
      expect(res.status).toBe(422); // guide v2: 422 = unknown parent (400 stays validation)
    });
  });

  // ── §3 Babysitter view ──────────────────────────────────────────────────────
  describe('GET {CHAINS_PATH}/{chainId} — babysitter view', () => {
    it('shows a freshly registered main chain as "declared" with no observed events', async () => {
      const reg = await postChains({ workflowId: WORKFLOW_ID });
      const main = mainChain(chainsOf(reg.body));
      expect(main).toBeTruthy();
      if (!main) return;

      const res = await getChain(main.chainId);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('declared');
      expect(res.body.observedEvents).toEqual([]);
      expect(res.body.parentEventId ?? null).toBeNull();
    });

    it('shows a detached chain with structural parent linkage but null parentEventId', async () => {
      const reg = await postChains({ workflowId: WORKFLOW_ID });
      const detached = aDetachedChain(chainsOf(reg.body));
      if (!detached) {
        expect.fail(`SYMPRAXIS_WORKFLOW_ID='${WORKFLOW_ID}' needs a detached chain`);
        return;
      }

      const res = await getChain(detached.chainId);
      expect(res.status).toBe(200);
      expect(String(res.body.parentChainId)).toMatch(UUID_RE);
      expect(res.body.parentEventId, 'runtime-discovered').toBeNull();
    });

    it('returns 404 for an unknown chainId', async () => {
      const res = await getChain(uuid());
      expect(res.status).toBe(404);
    });
  });

  // ── §3b Babysitter breach detection (late-declared chain, short timeout) ───
  describe('breach detection', () => {
    it('marks a chain "breached" (not-started) when order-0 never arrives', async () => {
      const reg = await postChains({ workflowId: WORKFLOW_ID });
      const main = mainChain(chainsOf(reg.body));
      expect(main).toBeTruthy();
      if (!main) return;

      const late = await postChains({
        chainRef: `breach-${uuid()}`,
        name: 'never-starts',
        parentChainId: main.chainId,
        expectedEvents: declaredEvents(['dev.cdevents.service.rolledback.0.3.0'], 1000),
      });
      const chainId = String(late.body.chainId);
      expect(chainId).toMatch(UUID_RE);

      const view = await pollUntil(
        () => getChain(chainId),
        (r) => r.body.status === 'breached',
        { timeoutMs: 8000, intervalMs: 400 },
      );
      expect(view.body.status).toBe('breached');
      const breaches = (view.body.breaches as Array<{ reason?: string }>) ?? [];
      expect(breaches.some((b) => b.reason === 'not-started')).toBe(true);
    }, 15000);

    // The other half of breach detection: a run that starts then stalls mid-chain
    // (the more common production failure). Needs ingestion to observe order-0.
    it.runIf(RUN_INGEST)(
      'marks a chain "breached" (hang) when order-1 stalls after order-0 is observed',
      async () => {
        const reg = await postChains({ workflowId: WORKFLOW_ID });
        const main = mainChain(chainsOf(reg.body));
        expect(main).toBeTruthy();
        if (!main) return;

        const order0 = 'dev.cdevents.service.rolledback.0.3.0';
        const late = await postChains({
          chainRef: `hang-${uuid()}`,
          name: 'stalls-midway',
          parentChainId: main.chainId,
          expectedEvents: [
            { type: order0, order: 0, timeoutMs: 30000 }, // generous: must not breach as not-started
            { type: 'dev.cdevents.service.published.0.3.0', order: 1, timeoutMs: 1000 }, // short: hang
          ],
        });
        const chainId = String(late.body.chainId);
        expect(chainId).toMatch(UUID_RE);

        // Observe order-0 only; withhold order-1 past its 1s deadline.
        expect(await emitCdEvent(cdEvent(chainId, order0))).toBe(EVENTS_STATUS);

        const view = await pollUntil(
          () => getChain(chainId),
          (r) => r.body.status === 'breached',
          { timeoutMs: 8000, intervalMs: 400 },
        );
        expect(view.body.status).toBe('breached');
        const breaches = (view.body.breaches as Array<{ reason?: string }>) ?? [];
        expect(breaches.some((b) => b.reason === 'hang')).toBe(true);
      },
      15000,
    );
  });

  // ── §4 Event association & runtime linkage (needs ingestion) ───────────────
  describe('event association & runtime linkage', () => {
    it.runIf(RUN_INGEST)(
      'transitions declared → in-progress → complete, and extras do not breach',
      async () => {
        const reg = await postChains({ workflowId: WORKFLOW_ID });
        const detached = aDetachedChain(chainsOf(reg.body));
        if (!detached) {
          expect.fail(`SYMPRAXIS_WORKFLOW_ID='${WORKFLOW_ID}' needs a detached chain`);
          return;
        }
        const { chainId, expectedEvents } = detached;
        const ordered = [...expectedEvents].sort((a, b) => a.order - b.order);

        // Emit every event except the last; after order-0 (and only when more
        // events remain) assert the some-but-not-all "in-progress" state.
        const lastIdx = ordered.length - 1;
        for (let i = 0; i < lastIdx; i++) {
          expect(await emitCdEvent(cdEvent(chainId, ordered[i].type))).toBe(EVENTS_STATUS);
          if (i === 0) {
            const mid = await pollUntil(
              () => getChain(chainId),
              (r) => r.body.status === 'in-progress',
              { timeoutMs: 8000 },
            );
            expect(mid.body.status, 'some-but-not-all observed → in-progress').toBe('in-progress');
          }
        }
        // An unexpected extra on the chain must NOT breach (observed ⊇ expected).
        await emitCdEvent(cdEvent(chainId, 'dev.cdevents.incident.detected.0.3.0'));
        // Final expected event carries the END link (self-referential id).
        const lastId = uuid();
        const last = ordered[ordered.length - 1];
        await emitCdEvent(
          cdEvent(chainId, last.type, [{ linkType: 'END', end: { contextId: lastId } }], lastId),
        );

        const view = await pollUntil(
          () => getChain(chainId),
          (r) => r.body.status === 'complete',
          { timeoutMs: 8000 },
        );
        expect(view.body.status).toBe('complete');
        expect(((view.body.breaches as unknown[]) ?? []).length).toBe(0);

        // Order join (guide v2 §2): each observedEvent carries the DECLARED
        // order — it must join against expectedEvents on (order, type).
        const expectedByOrder = new Map(ordered.map((e) => [e.order, e.type]));
        const observed =
          (view.body.observedEvents as Array<{ type: string; order?: number }>) ?? [];
        const joined = observed.filter((o) => typeof o.order === 'number');
        expect(joined.length).toBeGreaterThan(0);
        for (const o of joined) {
          expect(expectedByOrder.get(o.order!), `observed order ${o.order}`).toBe(o.type);
        }
      },
      20000,
    );

    it.runIf(RUN_INGEST)(
      "fills parentEventId when the spawning event's RELATION link is observed",
      async () => {
        const reg = await postChains({ workflowId: WORKFLOW_ID });
        const chains = chainsOf(reg.body);
        // Ratified anchors are `P.d` (flat form) or `P.d{i}` (nested form) —
        // select by role, which is normative, rather than by anchor spelling.
        const detached = chains.find((c) => c.role === 'detached');
        if (!detached) {
          expect.fail(
            `SYMPRAXIS_WORKFLOW_ID='${WORKFLOW_ID}' needs a detached chain spawned from a parent`,
          );
          return;
        }
        const parent = chains.find((c) => c.chainId === detached.parentChainId);
        // The spawning event sits at the chain's anchor: chainRef minus its
        // trailing axis segment (`.d`, `.d0`, `.s`, `.s1`, …).
        const spawnPath = detached.chainRef.replace(/\.[sd]\d*$/, '');
        const spawnEvent = parent?.expectedEvents.find((e) => e.treePath === spawnPath);
        if (!parent || !spawnEvent) {
          expect.fail('could not locate the spawning event for the detached chain');
          return;
        }

        const before = await getChain(detached.chainId);
        expect(before.body.parentEventId, 'null before parent observed').toBeNull();

        // Emit the detached chain's order-0 event (the RELATION target)…
        const detFirstId = uuid();
        const detFirst = [...detached.expectedEvents].sort((a, b) => a.order - b.order)[0];
        await emitCdEvent(cdEvent(detached.chainId, detFirst.type, undefined, detFirstId));

        // …then the parent's spawning event carrying RELATION → that target.
        const parentEventId = uuid();
        await emitCdEvent(
          cdEvent(
            parent.chainId,
            spawnEvent.type,
            [
              {
                linkType: 'RELATION',
                linkKind: detached.linkKind ?? 'TRIGGER',
                target: { contextId: detFirstId },
              },
            ],
            parentEventId,
          ),
        );

        const after = await pollUntil(
          () => getChain(detached.chainId),
          (r) => r.body.parentEventId != null,
          { timeoutMs: 8000 },
        );
        expect(after.body.parentEventId).toBe(parentEventId);
      },
      20000,
    );
  });

  // ── §4 Machine gate — server derivation EQUALS local derivation ────────────
  describe('machine gate: expectedEvents equal IM local derivation', () => {
    const SOURCES = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../fixtures/cdrus-goldens/sources',
    );

    /** Finds the mirror workflow file whose `workflow.id` matches. */
    function findWorkflowFile(id: string): string | undefined {
      if (!existsSync(SOURCES)) return undefined;
      for (const f of readdirSync(SOURCES).filter((n) => n.endsWith('.workflow.yaml'))) {
        const doc = yaml.load(readFileSync(path.join(SOURCES, f), 'utf-8')) as {
          workflow?: { id?: string };
        };
        if (doc.workflow?.id === id) return path.join(SOURCES, f);
      }
      return undefined;
    }

    /** Local derivation → chainRef → ordered [{treePath, order, type}]. */
    async function localDerivation(
      workflowPath: string,
    ): Promise<Map<string, { treePath: string; order: number; type: string }[]>> {
      setLogger(createLogger({ level: 'fatal', format: 'json' }));
      const registry = loadExpressionRegistry(SOURCES);
      const wf = await validateWorkflow(workflowPath);
      return new Map(
        flattenChains(resolveChainTree(wf, registry)).map((c) => [
          c.chainRef,
          c.events.map((e) => ({ treePath: e.treePath, order: e.order, type: e.type })),
        ]),
      );
    }

    // Guide v2 §4 defines the shared set as BOTH workflows — the gated deploy
    // AND the fanout — so the gate runs per shared workflow, each one skipped
    // independently when its fixture is absent from the mirror.
    const SHARED_SET: [string, string | undefined][] = [
      ['primary', WORKFLOW_ID],
      ['fanout', FANOUT_WORKFLOW_ID ?? 'build-fanout'],
    ];

    for (const [label, workflowId] of SHARED_SET) {
      it.runIf(Boolean(workflowId && findWorkflowFile(workflowId)))(
        `divergent documents under one workflow id are a red test, not a discovery (${label})`,
        async () => {
          const local = await localDerivation(findWorkflowFile(workflowId!)!);
          const res = await postChains({ workflowId });
          expect(res.status).toBe(200);
          const chains = chainsOf(res.body);

          expect(chains.map((c) => c.chainRef).sort()).toEqual([...local.keys()].sort());
          for (const c of chains) {
            const server = [...c.expectedEvents]
              .sort((a, b) => a.order - b.order)
              .map((e) => ({ treePath: e.treePath, order: e.order, type: e.type }));
            expect(server, `chain ${c.chainRef}`).toEqual(local.get(c.chainRef));
          }
        },
      );
    }
  });

  // ── §3 instanceId — presence and stability across one run's responses ──────
  describe('instanceId pinning', () => {
    it('is present and stable across register, view, and late declaration', async () => {
      const reg = await postChains({ workflowId: WORKFLOW_ID });
      const pinned = String(reg.body.instanceId);
      expect(pinned).toMatch(/^conduitd:/);
      const main = mainChain(chainsOf(reg.body));
      expect(main).toBeTruthy();
      if (!main) return;

      const view = await getChain(main.chainId);
      expect(String(view.body.instanceId)).toBe(pinned);

      const late = await postChains({
        chainRef: `pin-${uuid()}`,
        name: 'pin-check',
        parentChainId: main.chainId,
        expectedEvents: declaredEvents(['dev.cdevents.service.rolledback.0.3.0']),
      });
      expect(String(late.body.instanceId)).toBe(pinned);
    });
  });

  // ── Tool scoping — declared chains keep their events ───────────────────────
  describe('tool scoping', () => {
    it('returns arrays for every chain even when the tool matches nothing', async () => {
      const novelRef = `scoped-${uuid()}`;
      const res = await postChains({
        workflowId: WORKFLOW_ID,
        tool: `no-such-tool-${uuid().slice(0, 8)}`,
        verificationList: [
          {
            chainRef: novelRef,
            name: 'declared-under-scoping',
            parentChainRef: 'root',
            expectedEvents: declaredEvents(['dev.cdevents.ticket.created.0.2.0']),
          },
        ],
      });
      expect(res.status).toBe(200);
      for (const c of chainsOf(res.body)) {
        expect(Array.isArray(c.expectedEvents), `chain ${c.chainRef}`).toBe(true);
      }
      // Chains YOU declared keep their events regardless of scoping.
      const declared = chainsOf(res.body).find((c) => c.chainRef === novelRef);
      expect(declared?.expectedEvents.length).toBeGreaterThan(0);
    });
  });

  // ── Idempotency — retried register returns byte-equivalent statuses ────────
  describe('idempotent retry statuses', () => {
    it('echoes identical statuses on redelivery (added stays added)', async () => {
      const key = `idem-status-${uuid()}`;
      const novelRef = `idem-added-${uuid()}`;
      const body = {
        workflowId: WORKFLOW_ID,
        verificationList: [
          {
            chainRef: novelRef,
            name: 'idem-added',
            parentChainRef: 'root',
            expectedEvents: declaredEvents(['dev.cdevents.service.rolledback.0.3.0']),
          },
        ],
      };
      const first = await postChains(body, { idempotencyKey: key });
      const second = await postChains(body, { idempotencyKey: key });
      expect(first.status).toBe(200);

      const statusByRef = (r: Resp) => new Map(chainsOf(r.body).map((c) => [c.chainRef, c.status]));
      expect(statusByRef(second)).toEqual(statusByRef(first));
      expect(statusByRef(second).get(novelRef)).toBe('added');
    });
  });

  // ── §2 Late-declaration conflict matrix ────────────────────────────────────
  describe('late declaration conflicts', () => {
    it('echoes a re-declared chainRef under the same parent without minting anew', async () => {
      const reg = await postChains({ workflowId: WORKFLOW_ID });
      const main = mainChain(chainsOf(reg.body));
      expect(main).toBeTruthy();
      if (!main) return;

      const body = {
        chainRef: `echo-${uuid()}`,
        name: 'echo-me',
        parentChainId: main.chainId,
        expectedEvents: declaredEvents(['dev.cdevents.service.rolledback.0.3.0']),
      };
      const first = await postChains(body);
      const second = await postChains(body);
      expect(first.status).toBeLessThan(300);
      expect(second.status).toBeLessThan(300);
      expect(second.body.chainId).toBe(first.body.chainId);
    });

    it('rejects a chainRef naming a workflow chain with 409', async () => {
      const reg = await postChains({ workflowId: WORKFLOW_ID });
      const main = mainChain(chainsOf(reg.body));
      expect(main).toBeTruthy();
      if (!main) return;

      const res = await postChains({
        chainRef: 'root',
        name: 'collides-with-workflow-chain',
        parentChainId: main.chainId,
        expectedEvents: declaredEvents(['dev.cdevents.service.rolledback.0.3.0']),
      });
      expect(res.status).toBe(409);
    });

    it('rejects the same chainRef under a different parent with 409', async () => {
      const reg = await postChains({ workflowId: WORKFLOW_ID });
      const chains = chainsOf(reg.body);
      const main = mainChain(chains);
      const other = chains.find((c) => c.role !== 'main');
      expect(main && other).toBeTruthy();
      if (!main || !other) return;

      const ref = `dup-${uuid()}`;
      const under = (parentChainId: string) =>
        postChains({
          chainRef: ref,
          name: 'dup-ref',
          parentChainId,
          expectedEvents: declaredEvents(['dev.cdevents.service.rolledback.0.3.0']),
        });
      expect((await under(main.chainId)).status).toBeLessThan(300);
      expect((await under(other.chainId)).status).toBe(409);
    });
  });

  // ── Ingest guards — typed 400 and the 4 MiB cap ────────────────────────────
  describe('ingest guards', () => {
    it.runIf(RUN_INGEST)(
      "a chainId containing the word 'envelope' is data, not a malformed envelope",
      async () => {
        const status = await emitCdEvent(
          cdEvent(`envelope-${uuid()}`, 'dev.cdevents.change.created.0.3.0'),
        );
        expect(status).toBe(EVENTS_STATUS); // typed validation — never text-matched
      },
    );

    it.runIf(RUN_INGEST)('rejects a structurally malformed envelope with 400', async () => {
      const status = await emitCdEvent({ junk: true });
      expect(status).toBe(400);
    });

    it.runIf(RUN_INGEST)('rejects a body over 4 MiB with 413', async () => {
      const big = cdEvent(uuid(), 'dev.cdevents.change.created.0.3.0');
      (big.subject as Record<string, unknown>).content = { pad: 'x'.repeat(4_500_000) };
      const status = await emitCdEvent(big);
      expect(status).toBe(413);
    });
  });

  // ── Legacy shim — the producer's current acquisition path ──────────────────
  describe('legacy chainID shim', () => {
    it('resolves <workflow>:root to the freshly registered main chain, idempotently', async () => {
      const reg = await postChains({ workflowId: WORKFLOW_ID });
      const runId = String(reg.body.runId);

      const shim = async (): Promise<string> => {
        const res = await fetch(`${BASE_URL}/chainID`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ name: `${WORKFLOW_ID}:root` }),
          signal: AbortSignal.timeout(10000),
        });
        expect(res.status).toBe(200);
        return String(((await parse(res)) as { chainId?: string }).chainId);
      };
      const first = await shim();
      expect(first).toBe(runId); // pure lookup — minted at register
      expect(await shim()).toBe(first); // idempotent per (run, chainRef)
    });

    it('scoped form resolves per-run refs and 404s across workflows', async () => {
      const reg = await postChains({ workflowId: WORKFLOW_ID });
      const runId = String(reg.body.runId);
      const detached = aDetachedChain(chainsOf(reg.body));
      expect(detached).toBeTruthy();
      if (!detached) return;

      const scoped = (name: string) =>
        fetch(`${BASE_URL}/conduit/runs/${encodeURIComponent(runId)}/chainID`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ name }),
          signal: AbortSignal.timeout(10000),
        });

      const own = await scoped(`${WORKFLOW_ID}:${detached.chainRef}`);
      expect(own.status).toBe(200);
      const ownId = String(((await parse(own)) as { chainId?: string }).chainId);
      expect(ownId).toBe(detached.chainId);

      // Different-by-construction workflow id: whether it exists or not, the
      // scope chain cannot belong to it, so the scoped lookup must 404.
      const cross = await scoped(`not-${WORKFLOW_ID}:root`);
      expect(cross.status).toBe(404); // scope chain belongs to a different workflow
    });
  });

  // ── Bus-side declaration equivalence (needs a message-bus harness) ─────────
  it.todo('a standalone CDEvents START link off the bus is equivalent to a register call');
});
