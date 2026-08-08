/**
 * @module schema/catalog
 * Event-type version resolution (RFC §6.1, §6.2 step 5) — the TypeScript
 * port of conduit-go's `pkg/cdrus/catalog.go`, resolving the four §6.1
 * syntactic forms against a vendored catalog of known subject-schema
 * versions:
 *
 * - `dev.cdevents.build.started.0.3.0` — canonical embedded-version, exact
 * - `dev.cdevents.build.started:0.1.1` — colon form, exact (equivalent)
 * - `dev.cdevents.build.started`       — versionless → latest release
 * - `dev.cdevents.build.started:^0.1.0` — colon semver range (caret, tilde,
 *   x-ranges, single comparator; whitespace-separated sets are unauthorable
 *   under the schema's event pattern and rejected loudly)
 *
 * Extension types (`dev.cdeventsx.*`) pass through opaquely: resolution of
 * vendor types is out of the RFC's scope. An unknown CORE type or an
 * unsatisfiable version/range is a hard failure (§6.2 failure modes).
 *
 * PARITY IS LOAD-BEARING: the producer must resolve exactly as the daemon
 * does, or a versioned arrival will not match the daemon's resolved
 * expectation (conduit-go `TypeMatches`). The vendored catalog at
 * `schemas/cdrus/cdevents-catalog.json` mirrors the canonical copy in
 * conduit-go (`pkg/cdrus/cdevents-catalog.json`); a sync-check test enforces
 * byte-equality when the canonical repo is present. Canonical wins on drift.
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

/** Known versions per core `subject.predicate`, ascending. */
export interface EventCatalog {
  /** Returns the known versions, ascending, or `undefined` when unknown. */
  versions(subject: string, predicate: string): string[] | undefined;
}

/** One authored event-type string paired with its concrete resolution. */
export interface ResolvedEventType {
  /** The authored string, any §6.1 form, verbatim. */
  authored: string;
  /** CDEvents subject (for extensions, the `<tool>-<subject>` compound). */
  subject: string;
  /** CDEvents predicate. */
  predicate: string;
  /** The resolved concrete version; empty for pass-through extension types. */
  version: string;
  /** `true` for `dev.cdeventsx.*` extension types (opaque pass-through). */
  extension: boolean;
  /**
   * The concrete type to stamp on the wire (`context.type`) and to look the
   * payload schema up by: the canonical embedded-version spelling for core
   * types, the authored string verbatim for extensions.
   */
  wireType: string;
}

/** Matches a trailing `.MAJOR.MINOR.PATCH[-pre]` (§6.1 form 1). */
const EMBEDDED_VERSION = /^(.*?)\.(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/;

interface Semver {
  nums: [number, number, number];
  pre: string;
}

function parseVersion(s: string): Semver | null {
  const dash = s.indexOf('-');
  const core = dash === -1 ? s : s.slice(0, dash);
  const pre = dash === -1 ? '' : s.slice(dash + 1);
  const parts = core.split('.');
  if (parts.length !== 3) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(parseInt(p, 10));
  }
  return { nums: nums as [number, number, number], pre };
}

function isExactVersion(s: string): boolean {
  return parseVersion(s) !== null;
}

function cmpSemver(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] < b.nums[i] ? -1 : 1;
  }
  // A pre-release precedes its release; two pre-releases compare lexically
  // (sufficient for catalog data like 0.1.0-draft).
  if (a.pre === b.pre) return 0;
  if (a.pre === '') return 1;
  if (b.pre === '') return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** Compares two version strings; malformed input sorts lexically. */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (va === null || vb === null) return a < b ? -1 : a > b ? 1 : 0;
  return cmpSemver(va, vb);
}

/**
 * Picks the highest non-prerelease version, falling back to the highest
 * prerelease only when nothing else exists — standard semver posture: a
 * prerelease must be asked for explicitly.
 */
function latestRelease(versions: string[]): string {
  for (let i = versions.length - 1; i >= 0; i--) {
    const v = parseVersion(versions[i]);
    if (v !== null && v.pre === '') return versions[i];
  }
  return versions[versions.length - 1];
}

/**
 * The exclusive upper bound of a caret range: the next increment of the
 * leftmost non-zero component (`^0.1.0` admits `<0.2.0`, not `<1.0.0`).
 */
function caretUpper(lo: Semver): Semver {
  if (lo.nums[0] !== 0) return { nums: [lo.nums[0] + 1, 0, 0], pre: '' };
  if (lo.nums[1] !== 0) return { nums: [0, lo.nums[1] + 1, 0], pre: '' };
  return { nums: [0, 0, lo.nums[2] + 1], pre: '' };
}

/**
 * Whether the range's bound is itself a prerelease with the same numeric
 * tuple as `v` — the only case in which standard semver lets a prerelease
 * satisfy a range.
 */
function rangeMentionsPrerelease(rng: string, v: Semver): boolean {
  const bound = rng.replace(/^[\^~><=]+/, '');
  const b = parseVersion(bound);
  if (b === null || b.pre === '') return false;
  return b.nums[0] === v.nums[0] && b.nums[1] === v.nums[1] && b.nums[2] === v.nums[2];
}

function cmpAgainst(bound: string, v: Semver, ok: (d: number) => boolean): boolean {
  const b = parseVersion(bound);
  if (b === null) throw new Error(`unsupported range component '${bound}'`);
  return ok(cmpSemver(v, b));
}

/** x-range or partial: `1.2.x` / `1.x` / `1.2` / exact `1.2.3`. */
function xRangeMatches(c: string, v: Semver): boolean {
  const parts = c.split('.');
  if (parts.length > 3) throw new Error(`unsupported range component '${c}'`);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === 'x' || p === 'X' || p === '*') return true;
    if (!/^\d+$/.test(p)) throw new Error(`unsupported range component '${c}'`);
    if (v.nums[i] !== parseInt(p, 10)) return false;
  }
  return true;
}

function comparatorMatches(c: string, v: Semver): boolean {
  if (c === '*' || c === 'x' || c === 'X') return true;
  if (c.startsWith('^')) {
    const lo = parseVersion(c.slice(1));
    if (lo === null) throw new Error(`unsupported range component '${c}'`);
    if (cmpSemver(v, lo) < 0) return false;
    return cmpSemver(v, caretUpper(lo)) < 0;
  }
  if (c.startsWith('~')) {
    const lo = parseVersion(c.slice(1));
    if (lo === null) throw new Error(`unsupported range component '${c}'`);
    const up: Semver = { nums: [lo.nums[0], lo.nums[1] + 1, 0], pre: '' };
    return cmpSemver(v, lo) >= 0 && cmpSemver(v, up) < 0;
  }
  if (c.startsWith('>=')) return cmpAgainst(c.slice(2), v, (d) => d >= 0);
  if (c.startsWith('<=')) return cmpAgainst(c.slice(2), v, (d) => d <= 0);
  if (c.startsWith('>')) return cmpAgainst(c.slice(1), v, (d) => d > 0);
  if (c.startsWith('<')) return cmpAgainst(c.slice(1), v, (d) => d < 0);
  if (c.startsWith('=')) return cmpAgainst(c.slice(1), v, (d) => d === 0);
  return xRangeMatches(c, v);
}

/**
 * Evaluates one range expression against one version. Multi-comparator sets
 * are rejected loudly: the schemas' event pattern (`:[^\s]+`) makes a spaced
 * set unauthorable, so accepting one here would be dead grammar. Standard
 * semver prerelease posture: a prerelease matches only when the range's own
 * bound carries a prerelease of the same `[major.minor.patch]`.
 */
function rangeMatches(rng: string, version: string): boolean {
  if (/[ \t]/.test(rng)) {
    throw new Error(
      `multi-comparator range '${rng}' is not authorable (schema forbids whitespace in event types)`,
    );
  }
  const v = parseVersion(version);
  if (v === null) throw new Error(`not MAJOR.MINOR.PATCH: '${version}'`);
  if (v.pre !== '' && !rangeMentionsPrerelease(rng, v)) return false;
  return comparatorMatches(rng, v);
}

/** The vendored catalog implementation (versions pre-sorted ascending). */
class StaticCatalog implements EventCatalog {
  constructor(private readonly subjects: Record<string, Record<string, string[]>>) {}

  versions(subject: string, predicate: string): string[] | undefined {
    return this.subjects[subject]?.[predicate];
  }
}

/**
 * Parses a catalog document (the vendored JSON's shape) into an
 * {@link EventCatalog}, sorting each version list ascending. Exposed so tests
 * and embedders can supply their own catalogs; production loading goes
 * through {@link loadEventCatalog}.
 */
export function parseEventCatalog(doc: unknown): EventCatalog {
  const subjects = (doc as { subjects?: Record<string, Record<string, string[]>> })?.subjects;
  if (subjects === undefined || subjects === null || typeof subjects !== 'object') {
    throw new Error(`event catalog: missing 'subjects' map`);
  }
  for (const preds of Object.values(subjects)) {
    for (const versions of Object.values(preds)) {
      versions.sort(compareVersions);
    }
  }
  return new StaticCatalog(subjects);
}

let cachedCatalog: EventCatalog | undefined;

/**
 * Loads (and caches) the vendored catalog from
 * `schemas/cdrus/cdevents-catalog.json`. Update by reviewed bump against the
 * canonical copy in conduit-go, never at run time.
 */
export function loadEventCatalog(): EventCatalog {
  if (cachedCatalog === undefined) {
    const thisFile = fileURLToPath(import.meta.url);
    const path = resolve(dirname(thisFile), '../../schemas/cdrus/cdevents-catalog.json');
    cachedCatalog = parseEventCatalog(JSON.parse(readFileSync(path, 'utf-8')));
  }
  return cachedCatalog;
}

/**
 * Resolves one authored event-type string against the catalog (§6.2 step 5).
 *
 * @throws {Error} On every §6.2 failure mode: malformed type, empty version
 *   spec, unknown core type, missing exact version, unsatisfiable or
 *   unauthorable range.
 */
export function resolveEventType(authored: string, catalog: EventCatalog): ResolvedEventType {
  const colonIdx = authored.indexOf(':');
  const hasColon = colonIdx !== -1;
  const base = hasColon ? authored.slice(0, colonIdx) : authored;
  const spec = hasColon ? authored.slice(colonIdx + 1) : '';

  if (base.startsWith('dev.cdeventsx.')) {
    const parts = base.split('.');
    if (parts.length < 4) throw new Error(`malformed extension type '${authored}'`);
    return {
      authored,
      subject: parts[2],
      predicate: parts[3],
      version: '',
      extension: true,
      wireType: authored,
    };
  }

  let exact = '';
  let rng = '';
  let stripped = base;
  if (!hasColon) {
    const m = EMBEDDED_VERSION.exec(base);
    if (m !== null) {
      stripped = m[1];
      exact = m[2];
    }
  } else if (spec === '') {
    throw new Error(`empty version spec after ':' in '${authored}'`);
  } else if (isExactVersion(spec)) {
    exact = spec;
  } else {
    rng = spec;
  }

  const parts = stripped.split('.');
  if (parts.length !== 4 || parts[0] !== 'dev' || parts[1] !== 'cdevents') {
    throw new Error(`malformed event type '${authored}'`);
  }
  const subject = parts[2];
  const predicate = parts[3];

  const versions = catalog.versions(subject, predicate);
  if (versions === undefined || versions.length === 0) {
    throw new Error(`unknown CDEvent type ${subject}.${predicate} (from '${authored}')`);
  }

  const finish = (version: string): ResolvedEventType => ({
    authored,
    subject,
    predicate,
    version,
    extension: false,
    wireType: `dev.cdevents.${subject}.${predicate}.${version}`,
  });

  if (exact !== '') {
    if (versions.includes(exact)) return finish(exact);
    throw new Error(`no version ${exact} of ${subject}.${predicate} (from '${authored}')`);
  }
  if (rng !== '') {
    let best = '';
    for (const v of versions) {
      let ok: boolean;
      try {
        ok = rangeMatches(rng, v);
      } catch (err) {
        throw new Error(`range '${rng}' (from '${authored}'): ${(err as Error).message}`);
      }
      if (ok && (best === '' || compareVersions(v, best) > 0)) best = v;
    }
    if (best === '') {
      throw new Error(`no version of ${subject}.${predicate} satisfies '${rng}'`);
    }
    return finish(best);
  }
  return finish(latestRelease(versions)); // versionless → latest release
}

/**
 * Extracts the `subject.predicate` key from any §6.1 spelling — colon spec
 * and embedded version stripped, both `dev.cdevents.*` and `dev.cdeventsx.*`
 * namespaces — without touching the catalog. Returns `null` when the string
 * is not a CDEvent type. This is the catalog-free parse behind
 * `workflowEventId` derivation and bundle collision detection.
 */
export function subjectPredicateOfType(
  authored: string,
): { subject: string; predicate: string } | null {
  const colonIdx = authored.indexOf(':');
  const base = colonIdx === -1 ? authored : authored.slice(0, colonIdx);
  let stripped = base;
  if (!base.startsWith('dev.cdeventsx.')) {
    const m = EMBEDDED_VERSION.exec(base);
    if (m !== null) stripped = m[1];
  }
  const parts = stripped.split('.');
  if (
    parts.length < 4 ||
    parts[0] !== 'dev' ||
    (parts[1] !== 'cdevents' && parts[1] !== 'cdeventsx')
  ) {
    return null;
  }
  return { subject: parts[2], predicate: parts[3] };
}
