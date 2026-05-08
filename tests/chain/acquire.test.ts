import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acquireChainId } from '../../src/chain/acquire.js';

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

  it('falls back when conduit returns non-2xx', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({}),
    });

    const result = await acquireChainId('my-workflow', { url: 'https://conduit.example.com' });
    expect(result.source).toBe('fallback');
    expect(result.chainId).toMatch(/^urn:sol-duara:fallback:/);
  });

  it('falls back when conduit response has invalid UUID', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ chainId: 'not-a-uuid', issuedAt: new Date().toISOString() }),
    });

    const result = await acquireChainId('my-workflow', { url: 'https://conduit.example.com' });
    expect(result.source).toBe('fallback');
  });

  it('falls back when fetch throws (network error)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await acquireChainId('my-workflow', { url: 'https://conduit.example.com' });
    expect(result.source).toBe('fallback');
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
