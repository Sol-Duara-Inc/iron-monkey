/**
 * The tool's login: GET and HEAD on /api/executions and /api/executions/{id}
 * take a credential in the server's form; the bench never asks for one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import {
  ExecutionStore,
  INQUIRY_WINDOW_MS,
  RETENTION_SLACK_MS,
} from '../../src/execution/store.js';
import { startInquiryServer } from '../../src/execution/server.js';
import type { InquiryServer, InquiryServerOptions } from '../../src/execution/server.js';
import { resolveLoginSettings } from '../../src/execution/login.js';
import { createLogger, setLogger } from '../../src/logger/index.js';
import type { Logger } from '../../src/logger/index.js';
import type { Manifest } from '../../src/manifest/types.js';
import { makeTmpDir } from '../helpers.js';

const quiet = createLogger({ level: 'fatal', format: 'json' });
setLogger(quiet);

/** Made up, with an upper-case letter so a lower-cased copy is caught too. */
const TOKEN = 'im-test-token-7Qx';
const NO = 'no credential was presented';
const WRONG = 'the credential presented is not the one this tool takes';
const FAILS = "this tool's login is set to fail";
const E1 = '/api/executions/exec-1';
const BEARER = { Authorization: `Bearer ${TOKEN}` };
type Headers = Record<string, string>;
type Opts = Partial<InquiryServerOptions>;

const running: InquiryServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
  setLogger(quiet);
});

/** A store that answers 200 for `exec-1`, 410 for `old` and 404 for any other id. */
function store(): ExecutionStore {
  let now = 0;
  const s = new ExecutionStore({ capacity: 1, now: () => now });
  const manifest = { events: [] } as unknown as Manifest;
  s.open('old', 'wf', manifest);
  s.close('old');
  now += INQUIRY_WINDOW_MS + RETENTION_SLACK_MS + 1;
  s.open('exec-1', 'wf', manifest);
  return s;
}

const control = { startRun: () => Promise.resolve({ executionID: 'x', workflowId: 'wf' }) };

/** Starts a daemon; `control: undefined` gives the read-only server of `run --serve`. */
async function serve(opts: Opts = {}): Promise<InquiryServer> {
  const server = await startInquiryServer({ store: store(), control, ...opts });
  running.push(server);
  return server;
}

const b64 = (s: string): string => Buffer.from(s).toString('base64');
const basic = (s: string): string => `Basic ${b64(s)}`;

/** The status, and the reason when refused. */
async function ask(s: InquiryServer, headers: Headers = {}, path = E1, method = 'GET') {
  const res = await fetch(`${s.url}${path}`, { headers, method });
  if (res.status !== 401) return [res.status];
  return [res.status, ((await res.json()) as { reason: string }).reason];
}

const put = (s: InquiryServer, body: string) =>
  fetch(`${s.url}/api/control/login`, { method: 'PUT', body });

async function record(s: InquiryServer): Promise<Record<string, string>[]> {
  return ((await (await fetch(`${s.url}/api/control/logins`)).json()) as { logins: [] }).logins;
}

/** Captures, parsed, every log line of the servers started after it. */
function captureLog(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      for (const l of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(l));
      done();
    },
  });
  setLogger(pino({ level: 'info' }, sink) as unknown as Logger);
  return lines;
}

// Settings, then requests let in, presenting nothing in the form, and presenting another.
const forms: [Opts, Headers[], Headers[], Headers[]][] = [
  [
    { token: TOKEN },
    [BEARER, { Authorization: `bearer ${TOKEN}` }, { Authorization: `BEARER  ${TOKEN}` }],
    [{}, { Authorization: basic(TOKEN) }, { 'X-Api-Key': TOKEN }, { Authorization: 'Bearer' }],
    [{ Authorization: 'Bearer x' }, { Authorization: `Bearer ${TOKEN.toUpperCase()}` }],
  ],
  [
    { token: `carol:${TOKEN}`, tokenScheme: 'basic' },
    [
      { Authorization: basic(`carol:${TOKEN}`) },
      { Authorization: `basic ${b64(`carol:${TOKEN}`)}` },
    ],
    [{}, { Authorization: `Bearer carol:${TOKEN}` }, { Authorization: 'Basic' }],
    [{ Authorization: basic(`dave:${TOKEN}`) }, { Authorization: `Basic carol:${TOKEN}` }],
  ],
  [
    { token: TOKEN, tokenScheme: 'header:X-Api-Key' },
    [{ 'X-Api-Key': TOKEN }, { 'x-api-key': TOKEN }],
    [{}, BEARER, { 'X-Api-Key': '' }, { 'X-Other': TOKEN }],
    [{ 'X-Api-Key': 'x' }, { 'X-Api-Key': `Bearer ${TOKEN}` }],
  ],
];

describe('the settings `iron-monkey serve` starts with', () => {
  it('default to no token, bearer and succeed; an empty value is unset; a flag wins', () => {
    const want = { token: undefined, tokenScheme: 'bearer', login: 'succeed' };
    expect(resolveLoginSettings({}, {})).toEqual(want);
    const none = { IRON_MONKEY_TOKEN: '', IRON_MONKEY_TOKEN_SCHEME: '', IRON_MONKEY_LOGIN: '' };
    expect(resolveLoginSettings({}, none)).toEqual(want);
    expect(resolveLoginSettings({ token: '', tokenScheme: '', login: '' }, {})).toEqual(want);
    const env = {
      IRON_MONKEY_TOKEN: 'e',
      IRON_MONKEY_TOKEN_SCHEME: 'basic',
      IRON_MONKEY_LOGIN: 'fail',
    };
    expect(resolveLoginSettings({}, env)).toEqual({
      token: 'e',
      tokenScheme: 'basic',
      login: 'fail',
    });
    const flags = { token: 'f', tokenScheme: 'header:X-Api-Key', login: 'succeed' };
    expect(resolveLoginSettings(flags, env)).toEqual(flags);
    expect(resolveLoginSettings({ token: '' }, env).token).toBeUndefined();
  });

  it('read a scheme as Conduit writes one, and refuse any other value in one line', () => {
    const read = (s: string) => resolveLoginSettings({ tokenScheme: s }, {}).tokenScheme;
    const schemes = ['Bearer', ' BASIC ', 'Header: x-key-2 ', 'header:X-Api-Key'];
    expect(schemes.map(read)).toEqual(['bearer', 'basic', 'header:x-key-2', 'header:X-Api-Key']);
    for (const s of ['bogus', 'token', 'header:', 'header:X Api', 'header:X_Api', 'bearer x']) {
      const line = `--token-scheme (IRON_MONKEY_TOKEN_SCHEME) must be bearer, basic or header:<Name> with a name of letters, digits and hyphens, not ${JSON.stringify(s)}`;
      expect(() => read(s)).toThrow(new Error(line));
    }
    for (const l of ['bogus', 'FAIL', ' fail']) {
      const line = `--login (IRON_MONKEY_LOGIN) must be succeed or fail, not ${JSON.stringify(l)}`;
      expect(() => resolveLoginSettings({ login: l }, {})).toThrow(new Error(line));
    }
  });
});

describe("the tool's API behind a login", () => {
  it('lets the token in, in the form the scheme takes, and refuses anything else', async () => {
    for (const [opts, accepted, nothing, other] of forms) {
      const s = await serve(opts);
      for (const h of accepted) expect(await ask(s, h), JSON.stringify(h)).toEqual([200]);
      for (const h of nothing) expect(await ask(s, h), JSON.stringify(h)).toEqual([401, NO]);
      for (const h of other) expect(await ask(s, h), JSON.stringify(h)).toEqual([401, WRONG]);
      expect(await ask(s, accepted[0], '/api/executions')).toEqual([200]);
      expect(await ask(s, {}, '/api/executions')).toEqual([401, NO]);
    }
  });

  it('a login at fail refuses every caller; with no token at succeed, all are let in', async () => {
    for (const [opts, accepted] of forms) {
      for (const o of [opts, {}]) {
        const s = await serve({ ...o, login: 'fail' });
        for (const path of ['/api/executions', E1, '/api/executions/never']) {
          expect([await ask(s, accepted[0], path), await ask(s, {}, path)]).toEqual([
            [401, FAILS],
            [401, FAILS],
          ]);
        }
      }
    }
    for (const opts of [{}, { token: '' }, { token: '', tokenScheme: 'basic' as const }]) {
      const s = await serve(opts);
      for (const h of [{}, { Authorization: 'Bearer x' }, { 'X-Api-Key': 'x' }]) {
        expect([await ask(s, h), await ask(s, h, '/api/executions')]).toEqual([[200], [200]]);
      }
    }
  });

  it('HEAD meets the login; other methods there and the bench do not', async () => {
    const catalogDir = await makeTmpDir('im-login-catalog');
    for (const login of ['succeed', 'fail'] as const) {
      const s = await serve({ token: TOKEN, login, catalogDir });
      const status = async (path: string, method = 'GET', body?: string): Promise<number> =>
        (await fetch(`${s.url}${path}`, { method, body })).status;
      expect([await status(E1, 'HEAD'), await status('/api/executions', 'HEAD')]).toEqual([
        401, 401,
      ]);
      expect(await status(E1, 'PUT')).toBe(405);
      expect(await status('/healthz')).toBe(200);
      expect(await status('/api/catalog')).toBe(200);
      expect(await status('/api/executions', 'POST', '{"workflow":"w.yaml"}')).toBe(202);
      expect(await status('/api/control/go-dark')).toBe(200);
      expect(await status('/api/control/login')).toBe(200);
      expect(await status('/api/control/login', 'PUT', `{"login":"${login}"}`)).toBe(200);
      expect(await status('/api/control/logins')).toBe(200);
      expect(await status('/api/control/go-dark', 'POST', '{"seconds":30}')).toBe(200);
      expect(await status('/api/control/go-dark', 'DELETE')).toBe(200);
      expect([await status('/nope'), await status('/api/executionsfoo')]).toEqual([404, 404]);
    }
    const s = await serve({ token: TOKEN });
    const head = await fetch(`${s.url}${E1}`, { method: 'HEAD', headers: BEARER });
    expect(head.status).toBe(200);
  });

  it('a refusal is 401 JSON, never cached, with a challenge for bearer and basic only', async () => {
    const cases: [Opts, string | null, string][] = [
      [{ token: TOKEN }, 'Bearer realm="iron-monkey"', NO],
      [{ token: TOKEN, tokenScheme: 'basic' }, 'Basic realm="iron-monkey"', NO],
      [{ token: TOKEN, tokenScheme: 'header:X-Api-Key' }, null, NO],
      [{ token: TOKEN, login: 'fail' }, 'Bearer realm="iron-monkey"', FAILS],
      [{ login: 'fail' }, null, FAILS],
      [{ token: '', tokenScheme: 'basic', login: 'fail' }, null, FAILS],
    ];
    for (const [opts, challenge, reason] of cases) {
      const res = await fetch(`${(await serve(opts)).url}${E1}`);
      const h = (name: string) => res.headers.get(name);
      const got = [res.status, h('content-type'), h('cache-control'), h('www-authenticate')];
      expect(got).toEqual([401, 'application/json', 'no-store', challenge]);
      expect(await res.text()).toBe(`{"error":"unauthorized","reason":"${reason}"}`);
    }
  });

  it('a request let in gets the answer a server with no login gives, byte for byte', async () => {
    const shared = store();
    const open = await serve({ store: shared });
    const guarded = await serve({ store: shared, token: TOKEN });
    const paths = ['/api/executions', E1, '/api/executions/old', '/api/executions/never'];
    for (const [path, status] of paths.map((p, i) => [p, [200, 200, 410, 404][i]] as const)) {
      const want = await fetch(`${open.url}${path}`);
      const got = await fetch(`${guarded.url}${path}`, { headers: BEARER });
      const challenge = got.headers.get('www-authenticate');
      expect([want.status, got.status, challenge]).toEqual([status, status, null]);
      expect(await got.text()).toBe(await want.text());
    }
  });

  it('a darkened endpoint answers dark before the login is read, and records nothing', async () => {
    const lines = captureLog();
    const s = await serve({ token: TOKEN });
    await fetch(`${s.url}/api/control/go-dark`, { method: 'POST', body: '{"seconds":30}' });
    expect([await ask(s), await ask(s, { Authorization: 'Bearer x' })]).toEqual([[503], [503]]);
    expect(await record(s)).toEqual([]);
    expect(lines.filter((l) => l.route === E1 && l.outcome === undefined)).toHaveLength(2);
    await fetch(`${s.url}/api/control/go-dark`, { method: 'DELETE' });
    expect(await ask(s)).toEqual([401, NO]);
  });
});

describe('switching the login at run time', () => {
  it('reads and sets the login, the very next request obeys it, and the switch is logged', async () => {
    const lines = captureLog();
    const s = await serve({ token: TOKEN });
    const read = async () => (await fetch(`${s.url}/api/control/login`)).json();
    expect([await read(), await ask(s, BEARER)]).toEqual([{ login: 'succeed' }, [200]]);
    for (const [login, answer] of [
      ['fail', [401, FAILS]],
      ['succeed', [200]],
      ['fail', [401, FAILS]],
    ] as const) {
      const res = await put(s, JSON.stringify({ login }));
      const got = [res.status, await res.json(), await ask(s, BEARER), await read()];
      expect(got).toEqual([200, { login }, answer, { login }]);
    }
    const switched = lines.filter((l) => l.msg === 'login set').map((l) => l.login);
    expect(switched).toEqual(['fail', 'succeed', 'fail']);
    const started = await serve({ token: TOKEN, login: 'fail' });
    expect(await (await fetch(`${started.url}/api/control/login`)).json()).toEqual({
      login: 'fail',
    });
    expect(await ask(started, BEARER)).toEqual([401, FAILS]);
  });

  it('refuses any other body with 400, and the login stays as it was', async () => {
    const s = await serve({ token: TOKEN });
    const big = JSON.stringify({ login: 'fail', pad: 'x'.repeat(70 * 1024) });
    for (const body of ['{}', '{"login":"FAIL"}', '{"login":true}', '["fail"]', 'fail', '', big]) {
      const res = await put(s, body);
      const error = `{"error":"field 'login' must be \\"succeed\\" or \\"fail\\""}`;
      expect([res.status, await res.text()]).toEqual([400, error]);
    }
    expect(await ask(s, BEARER)).toEqual([200]);
  });

  it('other methods are unknown control routes; without a control plane all are', async () => {
    const s = await serve();
    for (const [route, method] of [
      ['/api/control/login', 'POST'],
      ['/api/control/logins', 'DELETE'],
    ]) {
      const res = await fetch(`${s.url}${route}`, { method });
      expect([res.status, await res.json()]).toEqual([
        404,
        { error: 'unknown control route', route },
      ]);
    }
    const ro = await serve({ token: TOKEN, control: undefined }); // as `run --serve` starts it
    expect((await fetch(`${ro.url}/api/control/login`)).status).toBe(404);
    expect((await put(ro, '{"login":"fail"}')).status).toBe(404);
    expect((await fetch(`${ro.url}/api/control/logins`)).status).toBe(404);
    expect([await ask(ro), await ask(ro, BEARER)]).toEqual([[401, NO], [200]]);
  });
});

describe('the login record', () => {
  it('holds each judged request, oldest first, by its form and never its value', async () => {
    const lines = captureLog();
    const s = await serve({ token: TOKEN, tokenScheme: 'header:X-Api-Key' });
    const before = Date.now();
    // method, route, headers, then what the record says was presented, and the reason if refused
    const asks: [string, string, Headers, string, string?][] = [
      ['GET', E1, { 'x-api-key': TOKEN }, 'header:X-Api-Key'],
      ['GET', '/api/executions', { 'X-Api-Key': 'x' }, 'header:X-Api-Key', WRONG],
      ['HEAD', E1, BEARER, 'bearer', NO],
      ['GET', E1, { Authorization: basic(`carol:${TOKEN}`) }, 'basic', NO],
      ['GET', E1, { Authorization: `token ${TOKEN}` }, 'token', NO],
      ['GET', E1, { Authorization: 'Bearer' }, 'bearer', NO],
      ['GET', E1, { Authorization: TOKEN }, 'authorization', NO],
      ['GET', E1, { Authorization: `${TOKEN.toUpperCase()} x` }, 'authorization', NO],
      ['GET', E1, { Authorization: 'Digest x' }, 'authorization', NO],
      ['GET', E1, { Authorization: '' }, 'none', NO],
      ['GET', E1, { 'X-Api-Key': TOKEN, ...BEARER }, 'header:X-Api-Key'],
    ];
    const bodies: string[] = [];
    for (const [method, route, headers] of asks) {
      bodies.push(await (await fetch(`${s.url}${route}`, { method, headers })).text());
      await fetch(`${s.url}/healthz`); // the bench is never recorded
    }
    await put(s, '{"login":"fail"}');
    bodies.push(await (await fetch(`${s.url}${E1}`, { headers: { 'X-Api-Key': TOKEN } })).text());
    asks.push(['GET', E1, {}, 'header:X-Api-Key', FAILS]);
    const after = Date.now();

    const logins = await record(s);
    const want = asks.map(([method, route, , presented, reason]) =>
      reason === undefined
        ? { method, route, presented, outcome: 'accepted' }
        : { method, route, presented, outcome: 'refused', reason },
    );
    expect(logins.map(({ at: _at, ...rest }) => rest)).toEqual(want);
    expect(Object.keys(logins[1])).toEqual([
      'at',
      'method',
      'route',
      'presented',
      'outcome',
      'reason',
    ]);
    for (const { at } of logins) {
      expect(at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(Date.parse(at) >= before && Date.parse(at) <= after).toBe(true);
    }
    // The log line of each judged request says the same, and nothing holds the token.
    const judged = lines.filter((l) => l.msg === 'inquiry request' && l.outcome !== undefined);
    expect(
      judged.map(({ presented, outcome, reason }) => ({ presented, outcome, reason })),
    ).toEqual(want.map(({ presented, outcome, reason }) => ({ presented, outcome, reason })));
    const everything = [...lines.map((l) => JSON.stringify(l)), ...bodies, JSON.stringify(logins)];
    expect(everything.join('\n').toLowerCase()).not.toContain(TOKEN.toLowerCase());
  });

  it('keeps the last 100, dropping the oldest', async () => {
    const s = await serve();
    for (let i = 0; i < 105; i++) await fetch(`${s.url}/api/executions/r-${i}`);
    const routes = (await record(s)).map((l) => l.route);
    expect([routes.length, routes[0], routes[99]]).toEqual([
      100,
      '/api/executions/r-5',
      '/api/executions/r-104',
    ]);
  });
});
