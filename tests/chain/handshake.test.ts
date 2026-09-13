/**
 * The chain handshake client. These are mostly the REFUSAL paths, because the
 * happy path is the least dangerous thing here: the whole point of the change
 * is that a producer must never mint its own chain ids while an authority is
 * answering — an event on an id the authority did not issue is refused at the
 * door, every time, with the run otherwise looking healthy.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  acquireChains,
  assertChainRefsMatchLocal,
  ROOT_CHAIN_REF,
} from '../../src/chain/handshake.js';
import { resolveChainTree } from '../../src/workflow/chain-tree.js';
import { createRegistry } from '../../src/expressions/loader.js';
import { createLogger, setLogger } from '../../src/logger/index.js';
import type { WorkflowFile } from '../../src/workflow/types.js';

setLogger(createLogger({ level: 'fatal', format: 'json' }));
afterEach(() => vi.unstubAllGlobals());

const CONDUIT = { url: 'http://conduit.example:8080' };

const answer = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const CHAINS = { root: 'run-1', 'p5.d': 'chain-2', 'p6.s0': 'chain-3' };
const OK = { runId: 'run-1', workflowId: 'wf', executionId: 'exec-1', chains: CHAINS };

describe('acquireChains — what goes on the wire', () => {
  it('is a GET, and carries workflow, tool and execution', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(answer(OK)));
    const set = await acquireChains('wf', CONDUIT, { tool: 'iron-monkey', execution: 'exec-1' });
    expect(set?.chains).toEqual(CHAINS);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { method: string },
    ];
    expect(init.method).toBe('GET');
    const q = new URL(url).searchParams;
    expect([q.get('workflow'), q.get('tool'), q.get('execution')]).toEqual([
      'wf',
      'iron-monkey',
      'exec-1',
    ]);
  });

  it('omits execution when there is none, rather than sending an empty one', async () => {
    // An empty handle is not the same as no handle: the run would be keyed on
    // `tool:` and collide with every other execution of that tool.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(answer(OK)));
    await acquireChains('wf', CONDUIT, { tool: 'iron-monkey' });
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(new URL(url).searchParams.has('execution')).toBe(false);
  });

  it('sends the bearer only when a token is configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(OK)));
    await acquireChains('wf', CONDUIT, { tool: 't' });
    const [, bare] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(bare.headers.Authorization).toBeUndefined();
    await acquireChains('wf', { ...CONDUIT, token: 'sec' }, { tool: 't' });
    const [, withTok] = (fetch as ReturnType<typeof vi.fn>).mock.calls[1] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(withTok.headers.Authorization).toBe('Bearer sec');
  });
});

describe('acquireChains — offline is legitimate, a refusal is NOT', () => {
  it('returns null when no Conduit is configured, without reaching the network', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(await acquireChains('wf', undefined, { tool: 't' })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns null when no daemon answers at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')));
    expect(await acquireChains('wf', CONDUIT, { tool: 't' })).toBeNull();
  });

  it.each([
    [400, 'missing tool'],
    [404, 'unknown workflow'],
    [500, 'boom'],
  ])('THROWS on %i rather than falling back to local minting', async (status, error) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(answer({ error }, status)));
    await expect(acquireChains('wf', CONDUIT, { tool: 't' })).rejects.toThrow(
      new RegExp(`HTTP ${status}`),
    );
  });

  it('names the existing run on a 409 so the caller can address it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(answer({ ...OK, runId: 'held-by' }, 409)));
    await expect(acquireChains('wf', CONDUIT, { tool: 't' })).rejects.toThrow(
      /existing runId held-by/,
    );
  });

  it('throws on a body that is not a chain set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(answer({ runId: 'r' })));
    await expect(acquireChains('wf', CONDUIT, { tool: 't' })).rejects.toThrow(/unusable body/);
  });

  it('throws when chain ids are not strings', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(answer({ runId: 'r', workflowId: 'wf', chains: { root: 7 } })),
    );
    await expect(acquireChains('wf', CONDUIT, { tool: 't' })).rejects.toThrow(/unusable body/);
  });

  it('redelivers a 503 and succeeds, because repeating a GET is safe', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(answer({ error: 'store' }, 503))
        .mockResolvedValueOnce(answer(OK)),
    );
    expect((await acquireChains('wf', CONDUIT, { tool: 't' }))?.runId).toBe('run-1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('gives up after a persistent 503 instead of minting locally', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer({ error: 'store' }, 503)));
    await expect(acquireChains('wf', CONDUIT, { tool: 't' })).rejects.toThrow(/503 .* 3 times/);
  });
});

/** A workflow whose tree has one detached and one spawned sub-chain. */
function treeWithSubChains() {
  const wf = {
    workflow: {
      id: 'wf',
      name: 'wf',
      defaults: { tool: 't', source: 'https://t.example/' },
      produces: [
        { event: 'dev.cdevents.pipelinerun.started.0.3.0' },
        {
          event: 'dev.cdevents.artifact.packaged.0.3.0',
          detach: [{ event: 'dev.cdevents.artifact.signed.0.3.0' }],
        },
        {
          event: 'dev.cdevents.testsuiterun.started.0.3.0',
          spawn: [[{ event: 'dev.cdevents.testcaserun.started.0.3.0' }]],
        },
      ],
    },
  } as unknown as WorkflowFile;
  return resolveChainTree(wf, createRegistry([]));
}

describe('assertChainRefsMatchLocal — the gate that survives', () => {
  const tree = treeWithSubChains();
  const localRefs = ['root', 'p1.d', 'p2.s0'];
  const set = (refs: string[]) => ({
    runId: 'r',
    workflowId: 'wf',
    chains: Object.fromEntries(refs.map((r) => [r, `id-${r}`])),
  });

  it('accepts the authority naming exactly the chains the producer derived', () => {
    expect(() => assertChainRefsMatchLocal(set(localRefs), tree)).not.toThrow();
  });

  it('treats the main line as `root` — that rename is the protocol, not a divergence', () => {
    // The producer calls the main chain by its own ref; the authority calls it
    // `root`. If this were compared naively every single run would fail.
    expect(Object.keys(set(localRefs).chains)).toContain(ROOT_CHAIN_REF);
    expect(() => assertChainRefsMatchLocal(set(localRefs), tree)).not.toThrow();
  });

  it('REJECTS a chain the producer derived and the daemon did not', () => {
    expect(() => assertChainRefsMatchLocal(set(['root', 'p1.d']), tree)).toThrow(
      /p2\.s0: the producer derived it, the daemon did not/,
    );
  });

  it('REJECTS a chain the daemon derived and the producer did not', () => {
    // This is the showcase failure: two documents under one workflow id, whose
    // sub-chains sit at different indices. Without this gate the producer mints
    // local URNs for the chains it cannot find and every event on them is
    // refused, run after run, with nothing said.
    expect(() => assertChainRefsMatchLocal(set([...localRefs, 'p6.s0']), tree)).toThrow(
      /p6\.s0: the daemon derived it, the producer did not/,
    );
  });

  it('prints BOTH derivations, so the divergence can actually be diagnosed', () => {
    try {
      assertChainRefsMatchLocal(set(['root', 'p5.d', 'p6.s0']), tree);
      expect.unreachable('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('producer derived: p1.d, p2.s0, root');
      expect(msg).toContain('daemon answered:  p5.d, p6.s0, root');
    }
  });
});
