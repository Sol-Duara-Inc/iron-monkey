import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JunctionBoxBus } from '../../src/bus/junctionbox.js';
import type { JunctionBoxBusConfig } from '../../src/config/types.js';
import type { CDEventPayload } from '../../src/manifest/types.js';

// ── fetch mock plumbing ──────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let fetchCalls: FetchCall[];
let fetchMock: ReturnType<typeof vi.fn>;

function mockResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

beforeEach(() => {
  fetchCalls = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    // Default sane responses by URL pattern; individual tests override via mockImplementation.
    if (url.endsWith('/health')) return mockResponse(200, 'ok');
    if (url.endsWith('/api/launch')) return mockResponse(200, { runId: 'run-acquired' });
    if (url.endsWith('/api/events')) return mockResponse(202, '');
    if (url.endsWith('/api/observatory')) return mockResponse(200, [{ workflowId: 'demo' }]);
    return mockResponse(404, '');
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = fetchMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ──────────────────────────────────────────────────────────────────────────────

const baseConfig: JunctionBoxBusConfig = {
  type: 'junction-box',
  url: 'http://localhost:3000',
};

const fullConfig: JunctionBoxBusConfig = {
  ...baseConfig,
  workflow_id: 'demo-1',
  health_check: true,
  launch: true,
  events_path: '/api/events',
  expected_status: 202,
  headers: { 'X-Test': '1' },
};

function makePayload(): CDEventPayload {
  return {
    context: {
      specversion: '0.5.1',
      id: 'evt-1',
      source: 'https://jenkins.example.com/',
      type: 'dev.cdevents.build.started.0.5.1',
      timestamp: '2026-05-08T00:00:00.000Z',
      chainId: 'chain-1',
    },
    subject: { id: 'subject-1', content: {} },
  };
}

// ── connect ──────────────────────────────────────────────────────────────────

describe('JunctionBoxBus.connect', () => {
  it('hits /health and /api/launch in order, capturing the runId as chainId', async () => {
    const bus = new JunctionBoxBus('jb', { ...baseConfig, workflow_id: 'demo-1' });
    await bus.connect();
    expect(fetchCalls.map((c) => c.url)).toEqual([
      'http://localhost:3000/health',
      'http://localhost:3000/api/launch',
    ]);
    expect(await bus.acquireChainId()).toBe('run-acquired');
  });

  it('forwards extra headers on every request', async () => {
    const bus = new JunctionBoxBus('jb', fullConfig);
    await bus.connect();
    for (const call of fetchCalls) {
      const headers = (call.init?.headers ?? {}) as Record<string, string>;
      expect(headers['X-Test']).toBe('1');
    }
  });

  it('strips trailing slash from base url', async () => {
    const bus = new JunctionBoxBus('jb', { ...baseConfig, url: 'http://localhost:3000/' });
    await bus.connect();
    expect(fetchCalls[0].url).toBe('http://localhost:3000/health');
  });

  it('skips the health check when health_check is false', async () => {
    const bus = new JunctionBoxBus('jb', {
      ...baseConfig,
      health_check: false,
      workflow_id: 'demo-1',
    });
    await bus.connect();
    expect(fetchCalls.map((c) => c.url)).toEqual(['http://localhost:3000/api/launch']);
  });

  it('skips the launch step when launch is false', async () => {
    const bus = new JunctionBoxBus('jb', {
      ...baseConfig,
      workflow_id: 'demo-1',
      launch: false,
    });
    await bus.connect();
    expect(fetchCalls.map((c) => c.url)).toEqual(['http://localhost:3000/health']);
    expect(await bus.acquireChainId()).toBeUndefined();
  });

  it('skips the launch step when no workflow_id is configured', async () => {
    const bus = new JunctionBoxBus('jb', baseConfig);
    await bus.connect();
    expect(fetchCalls.map((c) => c.url)).toEqual(['http://localhost:3000/health']);
    expect(await bus.acquireChainId()).toBeUndefined();
  });

  it('throws a clear error when the server is unreachable', async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('ECONNREFUSED');
    });
    const bus = new JunctionBoxBus('jb', baseConfig);
    await expect(bus.connect()).rejects.toThrow(/Junction Box unreachable/);
  });

  it('throws when /health returns a non-2xx status', async () => {
    fetchMock.mockImplementationOnce(async () => mockResponse(503, 'down'));
    const bus = new JunctionBoxBus('jb', baseConfig);
    await expect(bus.connect()).rejects.toThrow(/health check failed/);
  });

  it('throws when /api/launch returns an error and no runId', async () => {
    fetchMock
      .mockImplementationOnce(async () => mockResponse(200, 'ok')) // health
      .mockImplementationOnce(async () => mockResponse(500, 'boom')); // launch
    const bus = new JunctionBoxBus('jb', { ...baseConfig, workflow_id: 'demo-1' });
    await expect(bus.connect()).rejects.toThrow(/\/api\/launch failed/);
  });

  it('throws when /api/launch returns 200 but no runId', async () => {
    fetchMock
      .mockImplementationOnce(async () => mockResponse(200, 'ok'))
      .mockImplementationOnce(async () => mockResponse(200, {}));
    const bus = new JunctionBoxBus('jb', { ...baseConfig, workflow_id: 'demo-1' });
    await expect(bus.connect()).rejects.toThrow(/returned no runId/);
  });

  it('accepts a "workflow already active" launch reply that carries both error and runId', async () => {
    fetchMock
      .mockImplementationOnce(async () => mockResponse(200, 'ok'))
      .mockImplementationOnce(async () =>
        mockResponse(200, { runId: 'reused-run', error: 'workflow already active' }),
      );
    const bus = new JunctionBoxBus('jb', { ...baseConfig, workflow_id: 'demo-1' });
    await bus.connect();
    expect(await bus.acquireChainId()).toBe('reused-run');
  });
});

// ── emit ─────────────────────────────────────────────────────────────────────

describe('JunctionBoxBus.emit', () => {
  it('POSTs the payload as JSON to /api/events with the expected headers', async () => {
    const bus = new JunctionBoxBus('jb', baseConfig);
    await bus.connect();
    fetchCalls.length = 0;

    const payload = makePayload();
    await bus.emit(payload.context.type, payload.context.id, payload);

    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    expect(call.url).toBe('http://localhost:3000/api/events');
    expect(call.init?.method).toBe('POST');
    const headers = (call.init?.headers ?? {}) as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(call.init!.body as string)).toEqual(payload);
  });

  it('honours a custom events_path', async () => {
    const bus = new JunctionBoxBus('jb', { ...baseConfig, events_path: '/v2/ingest' });
    await bus.connect();
    fetchCalls.length = 0;
    // The default fetch dispatcher only knows /api/events; teach the mock to
    // resolve the custom path to 202 (and to still record the call).
    fetchMock.mockImplementationOnce(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return mockResponse(202, '');
    });

    const payload = makePayload();
    await bus.emit(payload.context.type, payload.context.id, payload);
    expect(fetchCalls[0].url).toBe('http://localhost:3000/v2/ingest');
  });

  it('throws on an unexpected status, surfacing the response body', async () => {
    const bus = new JunctionBoxBus('jb', baseConfig);
    await bus.connect();
    fetchMock.mockImplementationOnce(async () => mockResponse(400, { error: 'malformed' }));
    const payload = makePayload();
    await expect(bus.emit(payload.context.type, payload.context.id, payload)).rejects.toThrow(
      /HTTP 400.*malformed/,
    );
  });

  it('respects a non-default expected_status', async () => {
    const bus = new JunctionBoxBus('jb', { ...baseConfig, expected_status: 200 });
    await bus.connect();
    fetchMock.mockImplementationOnce(async () => mockResponse(200, '')); // would have been 202
    const payload = makePayload();
    await expect(
      bus.emit(payload.context.type, payload.context.id, payload),
    ).resolves.toBeUndefined();
  });

  it('refuses to emit before connect()', async () => {
    const bus = new JunctionBoxBus('jb', baseConfig);
    const payload = makePayload();
    await expect(bus.emit(payload.context.type, payload.context.id, payload)).rejects.toThrow(
      /not connected/,
    );
  });
});

// ── inspect / purge / disconnect ─────────────────────────────────────────────

describe('JunctionBoxBus.inspect', () => {
  it('returns the parsed body from /api/observatory', async () => {
    const bus = new JunctionBoxBus('jb', baseConfig);
    const result = await bus.inspect();
    expect(result.type).toBe('junction-box');
    expect(result.details.url).toBe('http://localhost:3000/api/observatory');
    expect(result.details.observatory).toEqual([{ workflowId: 'demo' }]);
  });

  it('falls back to raw text when the observatory body is not JSON', async () => {
    fetchMock.mockImplementationOnce(async () => mockResponse(200, 'not json'));
    const bus = new JunctionBoxBus('jb', baseConfig);
    const result = await bus.inspect();
    expect(result.details.observatory).toBe('not json');
  });
});

describe('JunctionBoxBus.purge', () => {
  it('is a no-op that does not call any HTTP endpoint', async () => {
    const bus = new JunctionBoxBus('jb', baseConfig);
    await bus.connect();
    fetchCalls.length = 0;
    await bus.purge();
    expect(fetchCalls).toEqual([]);
  });
});

describe('JunctionBoxBus.disconnect', () => {
  it('flips the connected flag so subsequent emit() throws', async () => {
    const bus = new JunctionBoxBus('jb', baseConfig);
    await bus.connect();
    await bus.disconnect();
    const payload = makePayload();
    await expect(bus.emit(payload.context.type, payload.context.id, payload)).rejects.toThrow(
      /not connected/,
    );
  });

  it('is safe to call without a prior connect()', async () => {
    const bus = new JunctionBoxBus('jb', baseConfig);
    await expect(bus.disconnect()).resolves.toBeUndefined();
  });
});
