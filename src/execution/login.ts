/**
 * @module execution/login
 * The mocked tool's login: the right credential in a form Conduit sends is
 * let in, anything else is refused, and a login set to fail refuses everyone,
 * as a tool refuses a revoked or expired credential. The credential is never
 * written down; the record keeps the FORM a request presented.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/** How the tool takes its credential. */
export type TokenScheme = 'bearer' | 'basic' | `header:${string}`;

/** Whether the tool's login lets a caller in. */
export type LoginSetting = 'succeed' | 'fail';

const NO_CREDENTIAL = 'no credential was presented';
const WRONG_CREDENTIAL = 'the credential presented is not the one this tool takes';
const LOGIN_FAILS = "this tool's login is set to fail";

/** How many judged requests the login record keeps. */
export const LOGIN_RECORD_SIZE = 100;

/** The login a server runs with. */
export interface LoginSettings {
  /** Undefined or empty: no credential is asked. */
  token?: string;
  tokenScheme: TokenScheme;
  login: LoginSetting;
}

/** What the login made of one request. */
export interface LoginVerdict {
  /** The form the request presented, never its value. */
  presented: string;
  outcome: 'accepted' | 'refused';
  /** On a refusal only. */
  reason?: string;
}

/** One entry of the login record. */
export interface LoginRecordEntry extends LoginVerdict {
  /** When the request arrived, ISO-8601. */
  at: string;
  method: string;
  route: string;
}

const HEADER_NAME = /^[A-Za-z0-9-]+$/;

/**
 * Reads a scheme as Conduit reads one, so a scheme copied from Conduit means
 * the same here: spaces around it are ignored, the word matches in any case,
 * and a header's name is kept as written.
 */
function parseTokenScheme(value: string): TokenScheme | undefined {
  const scheme = value.trim();
  const lower = scheme.toLowerCase();
  if (lower === 'bearer' || lower === 'basic') return lower;
  if (!lower.startsWith('header:')) return undefined;
  const name = scheme.slice('header:'.length).trim();
  return HEADER_NAME.test(name) ? `header:${name}` : undefined;
}

/**
 * The login `iron-monkey serve` starts with. A flag wins over its variable,
 * and an empty value is an unset one.
 *
 * @throws One line naming the setting, when a value is outside its values.
 */
export function resolveLoginSettings(
  flags: { token?: string; tokenScheme?: string; login?: string },
  env: NodeJS.ProcessEnv,
): LoginSettings {
  const token = flags.token ?? env.IRON_MONKEY_TOKEN;
  const scheme = flags.tokenScheme ?? env.IRON_MONKEY_TOKEN_SCHEME;
  const login = flags.login ?? env.IRON_MONKEY_LOGIN;

  let tokenScheme: TokenScheme = 'bearer';
  if (scheme !== undefined && scheme !== '') {
    const parsed = parseTokenScheme(scheme);
    if (parsed === undefined) {
      throw new Error(
        `--token-scheme (IRON_MONKEY_TOKEN_SCHEME) must be bearer, basic or header:<Name> with a name of letters, digits and hyphens, not ${JSON.stringify(scheme)}`,
      );
    }
    tokenScheme = parsed;
  }

  if (login !== undefined && login !== '' && login !== 'succeed' && login !== 'fail') {
    throw new Error(
      `--login (IRON_MONKEY_LOGIN) must be succeed or fail, not ${JSON.stringify(login)}`,
    );
  }

  return {
    token: token === '' ? undefined : token,
    tokenScheme,
    login: login === 'fail' ? 'fail' : 'succeed',
  };
}

/**
 * The challenge a refusal carries when a token is set: one for `bearer` and
 * `basic`, none for a header of the tool's own naming.
 */
export function loginChallenge(token: string | undefined, scheme: TokenScheme): string | undefined {
  if (token === undefined || token === '') return undefined;
  if (scheme === 'bearer') return 'Bearer realm="iron-monkey"';
  if (scheme === 'basic') return 'Basic realm="iron-monkey"';
  return undefined;
}

/** `Authorization` as its first word, lower-cased, and what follows the spaces after it. */
function authorization(headers: IncomingHttpHeaders): { word: string; rest?: string } | undefined {
  const value = headers.authorization;
  if (value === undefined || value === '') return undefined;
  const space = value.indexOf(' ');
  if (space < 0) return { word: value.toLowerCase() };
  return { word: value.slice(0, space).toLowerCase(), rest: value.slice(space).trimStart() };
}

/** The header a `header:<Name>` scheme names, if present and not empty; Node lower-cases names. */
function namedHeader(headers: IncomingHttpHeaders, scheme: TokenScheme): string | undefined {
  if (!scheme.startsWith('header:')) return undefined;
  const value = headers[scheme.slice('header:'.length).toLowerCase()];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Compares two secrets in constant time, whatever their lengths. */
function sameSecret(presented: Buffer, expected: Buffer): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The words of `Authorization` the record names. Any other is `authorization`,
 * because a caller may have put the credential itself where the word goes.
 */
const NAMED_WORDS: ReadonlySet<string> = new Set(['bearer', 'basic', 'token']);

/** The form a request presented: the scheme's header, else a named word of `Authorization`. */
function presentedForm(headers: IncomingHttpHeaders, scheme: TokenScheme): string {
  if (namedHeader(headers, scheme) !== undefined) return scheme;
  const auth = authorization(headers);
  if (auth === undefined) return 'none';
  return NAMED_WORDS.has(auth.word) ? auth.word : 'authorization';
}

/** The credential presented in the scheme's form, or `undefined` when none was. */
function presentedCredential(
  headers: IncomingHttpHeaders,
  scheme: TokenScheme,
): Buffer | undefined {
  if (scheme.startsWith('header:')) {
    const value = namedHeader(headers, scheme);
    return value === undefined ? undefined : Buffer.from(value);
  }
  const auth = authorization(headers);
  if (auth === undefined || auth.word !== scheme || auth.rest === undefined) return undefined;
  return Buffer.from(auth.rest, scheme === 'basic' ? 'base64' : 'utf-8');
}

/**
 * Judges one request to the tool's API. A login set to fail refuses first,
 * whatever was presented. A tool with no token lets every caller in.
 * Otherwise the request must present the token in the scheme's form.
 */
export function judgeLogin(headers: IncomingHttpHeaders, settings: LoginSettings): LoginVerdict {
  const { token, tokenScheme, login } = settings;
  const presented = presentedForm(headers, tokenScheme);
  if (login === 'fail') return { presented, outcome: 'refused', reason: LOGIN_FAILS };
  if (token === undefined || token === '') return { presented, outcome: 'accepted' };
  const credential = presentedCredential(headers, tokenScheme);
  if (credential === undefined) return { presented, outcome: 'refused', reason: NO_CREDENTIAL };
  if (!sameSecret(credential, Buffer.from(token))) {
    return { presented, outcome: 'refused', reason: WRONG_CREDENTIAL };
  }
  return { presented, outcome: 'accepted' };
}
