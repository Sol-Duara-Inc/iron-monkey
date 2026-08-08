import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acquireChainId, acquireChainIds, ConduitAnsweredError } from '../../src/chain/acquire.js';

describe('acquireChainId', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns fallback when no conduit config', async () => {
    const result = await acquireChainId('my-workflow');
    expect(result.source).toBe('fallback');
    expect(result.chainId).toMatch(/^urn:sol-duara:fallback:/);
  });

  it('returns chainId from conduit on success', async () => {
    const mockChainId = '550e8400-e29b-41d4-a716-446655440000';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ chainId: mockChainId, issuedAt: new Date().toISOString() }),
    });

    const result = await acquireChainId('my-workflow', { url: 'https://conduit.example.com' });
    expect(result.source).toBe('conduit');
    expect(result.chainId).toBe(mockChainId);
  });

  it('THROWS (run-scoped) when the daemon answers non-2xx — no silent fallback', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({}),
    });

    await expect(
      acquireChainId('my-workflow', { url: 'https://conduit.example.com' }),
    ).rejects.toThrow(ConduitAnsweredError);
  });

  it('includes redeliver guidance when the daemon answers 503', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({}),
    });

    await expect(
      acquireChainId('my-workflow', { url: 'https://conduit.example.com' }),
    ).rejects.toThrow(/503 is a transient store failure — redeliver/);
  });

  it('THROWS when the daemon answers with an invalid chainId', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ chainId: 'not-a-uuid', issuedAt: new Date().toISOString() }),
    });

    await expect(
      acquireChainId('my-workflow', { url: 'https://conduit.example.com' }),
    ).rejects.toThrow(/did not contain a valid chainId UUID/);
  });

  it('THROWS when the daemon answers non-JSON', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('unexpected token');
      },
    });

    await expect(
      acquireChainId('my-workflow', { url: 'https://conduit.example.com' }),
    ).rejects.toThrow(/answered non-JSON/);
  });

  it('falls back when fetch throws (no daemon answered)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await acquireChainId('my-workflow', { url: 'https://conduit.example.com' });
    expect(result.source).toBe('fallback');
    expect(result.chainId).toMatch(/^urn:sol-duara:fallback:/);
  });

  it('includes Authorization header when token is configured', async () => {
    const mockChainId = '550e8400-e29b-41d4-a716-446655440001';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ chainId: mockChainId, issuedAt: new Date().toISOString() }),
    });

    await acquireChainId('my-workflow', { url: 'https://conduit.example.com', token: 'secret' });

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer secret');
  });
});

describe('acquireChainIds (per sub-chain)', () => {
  const reqs = [
    { chainRef: 'p1.d', parentChainRef: 'root', linkKind: 'TRIGGER' },
    { chainRef: 'p2.b0', parentChainRef: 'root', linkKind: 'TRIGGER' },
  ];

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a distinct fallback URN per chain under noConduit, with no network', async () => {
    const map = await acquireChainIds('wf', reqs, { noConduit: true });
    expect(map.size).toBe(2);
    expect(map.get('p1.d')!.source).toBe('fallback');
    expect(map.get('p1.d')!.chainId).toMatch(/^urn:sol-duara:fallback:/);
    expect(map.get('p1.d')!.chainId).not.toBe(map.get('p2.b0')!.chainId);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('mints each chain via Conduit, naming it <workflow>:<chainRef>', async () => {
    const ids = ['550e8400-e29b-41d4-a716-446655440010', '550e8400-e29b-41d4-a716-446655440011'];
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ chainId: ids[0], issuedAt: new Date().toISOString() }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ chainId: ids[1], issuedAt: new Date().toISOString() }),
      });

    const map = await acquireChainIds(
      'wf',
      reqs,
      { noConduit: false },
      {
        url: 'https://conduit.example.com',
      },
    );
    expect(map.get('p1.d')).toEqual({ chainId: ids[0], source: 'conduit' });
    expect(map.get('p2.b0')).toEqual({ chainId: ids[1], source: 'conduit' });

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).name).toBe('wf:p1.d');
  });

  it('propagates a daemon-answered error instead of minting fallbacks', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({}),
    });
    await expect(
      acquireChainIds('wf', reqs, { noConduit: false }, { url: 'https://conduit.example.com' }),
    ).rejects.toThrow(ConduitAnsweredError);
  });

  it('falls back per chain when no daemon answers', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));
    const map = await acquireChainIds(
      'wf',
      reqs,
      { noConduit: false },
      {
        url: 'https://conduit.example.com',
      },
    );
    expect(map.get('p1.d')!.source).toBe('fallback');
    expect(map.get('p2.b0')!.source).toBe('fallback');
  });

  it('returns an empty map (no network) when there are no sub-chains', async () => {
    const map = await acquireChainIds(
      'wf',
      [],
      { noConduit: false },
      {
        url: 'https://conduit.example.com',
      },
    );
    expect(map.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
