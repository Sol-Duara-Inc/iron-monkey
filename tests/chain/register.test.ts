import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  registerRun,
  assertRegisterMatchesLocal,
  ConduitAnsweredError,
} from '../../src/chain/register.js';
import type { RegisterResult } from '../../src/chain/register.js';
import type { ResolvedChain } from '../../src/workflow/chain-tree.js';

const CONDUIT = { url: 'http://conduit.example:8091' };

const RESULT: RegisterResult = {
  runId: 'run-1111',
  instanceId: 'conduitd:u@h:9:aa',
  issuedAt: '2026-08-09T00:00:00Z',
  chains: [
    {
      chainRef: 'root',
      chainId: 'run-1111',
      role: 'main',
      status: 'declared',
      parentChainId: null,
      parentChainRef: null,
      parentEventId: null,
      linkKind: null,
      expectedEvents: [
        { type: 'dev.cdevents.build.started.0.3.0', treePath: 'p0', order: 0, timeoutMs: 5000 },
      ],
    },
    {
      chainRef: 'p0.d',
      chainId: 'chain-2222',
      role: 'detached',
      status: 'declared',
      parentChainId: 'run-1111',
      parentChainRef: 'root',
      parentEventId: null,
      linkKind: 'TRIGGER',
      expectedEvents: [
        { type: 'dev.cdevents.ticket.created.0.2.0', treePath: 'p0.d0', order: 0, timeoutMs: 5000 },
      ],
    },
  ],
};

function ok(body: unknown): Partial<Response> {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;

describe('registerRun — the batch register client', () => {
  it('returns null (offline) when conduit is unconfigured', async () => {
    expect(await registerRun('wf')).toBeNull();
    expect(await registerRun('wf', { url: '' })).toBeNull();
  });

  it('returns the minted chain set and sends no chainId in the request', async () => {
    fetchMock().mockResolvedValueOnce(ok(RESULT));
    const result = await registerRun('wf', CONDUIT);
    expect(result?.runId).toBe('run-1111');
    expect(result?.instanceId).toBe('conduitd:u@h:9:aa');

    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://conduit.example:8091/api/runs');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ workflowId: 'wf' }); // never a client-supplied chainId
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
  });

  it('scopes by tool when asked', async () => {
    fetchMock().mockResolvedValueOnce(ok(RESULT));
    await registerRun('wf', CONDUIT, { tool: 'jenkins-prod' });
    const [, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).tool).toBe('jenkins-prod');
  });

  it('returns null when NO daemon answers first contact (offline fallback legitimate)', async () => {
    fetchMock().mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await registerRun('wf', CONDUIT)).toBeNull();
  });

  it('THROWS when the daemon answers a non-503 HTTP error', async () => {
    fetchMock().mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' });
    await expect(registerRun('wf', CONDUIT)).rejects.toThrow(ConduitAnsweredError);
  });

  it('redelivers on 503 with the SAME Idempotency-Key, then succeeds', async () => {
    fetchMock()
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' })
      .mockResolvedValueOnce(ok(RESULT));

    const result = await registerRun('wf', CONDUIT, { idempotencyKey: 'idem-1' });
    expect(result?.runId).toBe('run-1111');
    const keys = fetchMock().mock.calls.map(
      (c) => (c[1] as RequestInit & { headers: Record<string, string> }).headers['Idempotency-Key'],
    );
    expect(keys).toEqual(['idem-1', 'idem-1']); // byte-equivalent redelivery
  });

  it('gives up after the retry budget with the redeliver guidance', async () => {
    fetchMock().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });
    await expect(registerRun('wf', CONDUIT, { maxAttempts: 2 })).rejects.toThrow(
      /503.*2 times.*redeliver/,
    );
    expect(fetchMock().mock.calls).toHaveLength(2);
  });

  it('THROWS when the daemon dies mid-redelivery (answered, then vanished)', async () => {
    fetchMock()
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' })
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(registerRun('wf', CONDUIT)).rejects.toThrow(/stopped answering during register/);
  });

  it('THROWS on a structurally invalid chain set', async () => {
    fetchMock().mockResolvedValueOnce(ok({ runId: 'x', chains: 'nope' }));
    await expect(registerRun('wf', CONDUIT)).rejects.toThrow(/not a valid chain set/);
  });
});

describe('assertRegisterMatchesLocal — the producer-side machine gate', () => {
  const local: ResolvedChain = {
    role: 'main',
    chainRef: 'root',
    events: [
      {
        treePath: 'p0',
        order: 0,
        workflowEventId: 'build-started',
        type: 'dev.cdevents.build.started.0.3.0',
        tool: '',
        source: '',
        pipeline: '',
        timeout_ms: 5000,
        min_wait_ms: 100,
        subject: { id: 'build-started' },
        origin: 'event',
      },
    ],
    spawns: [
      {
        role: 'detached',
        chainRef: 'p0.d',
        parentChainRef: 'root',
        anchorPath: 'p0',
        linkKind: 'TRIGGER',
        events: [
          {
            treePath: 'p0.d0',
            order: 0,
            workflowEventId: 'ticket-created',
            type: 'dev.cdevents.ticket.created.0.2.0',
            tool: '',
            source: '',
            pipeline: '',
            timeout_ms: 5000,
            min_wait_ms: 100,
            subject: { id: 'ticket-created' },
            origin: 'event',
          },
        ],
        spawns: [],
      },
    ],
  };

  it('accepts a byte-equal derivation', () => {
    expect(() => assertRegisterMatchesLocal(RESULT, local)).not.toThrow();
  });

  it('rejects when the daemon lacks a chain the producer derived', () => {
    const missing = { ...RESULT, chains: [RESULT.chains[0]] };
    expect(() => assertRegisterMatchesLocal(missing, local)).toThrow(
      /p0\.d: missing from daemon derivation/,
    );
  });

  it('rejects when the daemon derived a chain the producer did not', () => {
    const extra = {
      ...RESULT,
      chains: [...RESULT.chains, { ...RESULT.chains[1], chainRef: 'p9.d' }],
    };
    expect(() => assertRegisterMatchesLocal(extra, local)).toThrow(
      /p9\.d: daemon derived a chain the producer did not/,
    );
  });

  it('rejects diverging expectedEvents under one chainRef', () => {
    const diverged = structuredClone(RESULT);
    diverged.chains[1].expectedEvents[0].type = 'dev.cdevents.ticket.updated.0.2.0';
    expect(() => assertRegisterMatchesLocal(diverged, local)).toThrow(
      /p0\.d: expectedEvents diverge/,
    );
  });
});
