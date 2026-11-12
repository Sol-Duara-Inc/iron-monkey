/**
 * `iron-monkey serve` reads the tool's login from its flags and environment,
 * a flag winning, and refuses a setting outside its values before it listens.
 * Driven through commander; each daemon retires itself after a short idle
 * window, so every run ends on its own.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { serveCommand } from '../../src/cli/commands/serve.js';

const KEYS = ['IRON_MONKEY_TOKEN', 'IRON_MONKEY_TOKEN_SCHEME', 'IRON_MONKEY_LOGIN'];
const saved: Record<string, string | undefined> = {};
let printed = '';

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  printed = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    printed += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function serve(args: string[]): Promise<unknown> {
  const base = ['--port', '0', '--idle-timeout', '300', '--log-level', 'error'];
  return serveCommand().parseAsync([...base, ...args], { from: 'user' });
}

/** Starts the daemon; answers its address, read from the line it prints, and its run. */
async function daemon(args: string[]): Promise<[string, Promise<unknown>]> {
  const done = serve(args);
  for (let i = 0; i < 300; i++) {
    const found = printed.match(/iron-monkey daemon: (\S+)/);
    if (found) return [found[1], done];
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the daemon never printed its address');
}

async function status(url: string, headers: Record<string, string> = {}): Promise<number> {
  return (await fetch(`${url}/api/executions`, { headers })).status;
}

describe('serve: the login settings', () => {
  it('refuses a login or a scheme outside its values before it listens', async () => {
    const login = '--login (IRON_MONKEY_LOGIN) must be succeed or fail, not "bogus"';
    const scheme = (s: string) =>
      `--token-scheme (IRON_MONKEY_TOKEN_SCHEME) must be bearer, basic or header:<Name> with a name of letters, digits and hyphens, not "${s}"`;
    await expect(serve(['--login', 'bogus'])).rejects.toThrow(new Error(login));
    await expect(serve(['--token-scheme', 'header:'])).rejects.toThrow(
      new Error(scheme('header:')),
    );
    process.env.IRON_MONKEY_TOKEN_SCHEME = 'token';
    await expect(serve([])).rejects.toThrow(new Error(scheme('token')));
    process.env.IRON_MONKEY_TOKEN_SCHEME = '';
    process.env.IRON_MONKEY_LOGIN = 'bogus';
    await expect(serve([])).rejects.toThrow(new Error(login));
    expect(printed).not.toContain('iron-monkey daemon:');
  });

  it('takes its settings from the environment', async () => {
    process.env.IRON_MONKEY_TOKEN = 'im-env-token';
    process.env.IRON_MONKEY_TOKEN_SCHEME = 'header:X-Api-Key';
    const [url, done] = await daemon([]);
    expect(await status(url, { 'X-Api-Key': 'im-env-token' })).toBe(200);
    expect(await status(url, { Authorization: 'Bearer im-env-token' })).toBe(401);
    expect(await (await fetch(`${url}/api/control/login`)).json()).toEqual({ login: 'succeed' });
    await done; // the daemon retires itself after the idle window
  });

  it('a flag wins over its variable', async () => {
    process.env.IRON_MONKEY_TOKEN = 'im-env-token';
    process.env.IRON_MONKEY_TOKEN_SCHEME = 'header:X-Api-Key';
    process.env.IRON_MONKEY_LOGIN = 'succeed';
    const flags = ['--token', 'im-flag-token', '--token-scheme', 'bearer', '--login', 'fail'];
    const [url, done] = await daemon(flags);
    expect(await status(url, { Authorization: 'Bearer im-flag-token' })).toBe(401);
    await fetch(`${url}/api/control/login`, { method: 'PUT', body: '{"login":"succeed"}' });
    expect(await status(url, { Authorization: 'Bearer im-flag-token' })).toBe(200);
    expect(await status(url, { 'X-Api-Key': 'im-env-token' })).toBe(401);
    await done;
  });

  it('with no token set, the tool takes no credential', async () => {
    const [url, done] = await daemon([]);
    expect(await status(url)).toBe(200);
    await done;
  });
});
