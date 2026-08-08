/**
 * Event-type version resolution (RFC §6.1, §6.2 step 5) — the TS port of
 * conduit-go's catalog. The table cases mirror the Go side's
 * `typematches_test.go`/catalog coverage so both implementations resolve
 * identically; the sync-check enforces that the vendored catalog DATA is
 * byte-equal to canonical (conduit-go) when that repo is present.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadEventCatalog,
  parseEventCatalog,
  resolveEventType,
  subjectPredicateOfType,
  compareVersions,
} from '../../src/schema/catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDORED = path.resolve(__dirname, '../../schemas/cdrus/cdevents-catalog.json');
const CANONICAL = process.env.CONDUIT_GO_CATALOG
  ? path.resolve(process.env.CONDUIT_GO_CATALOG)
  : path.join(process.env.HOME ?? '', 'IdeaProjects/conduit-go/pkg/cdrus/cdevents-catalog.json');

const cat = loadEventCatalog();

describe('resolveEventType — the four §6.1 forms', () => {
  it('embedded exact resolves to itself', () => {
    const r = resolveEventType('dev.cdevents.build.started.0.3.0', cat);
    expect(r).toMatchObject({
      subject: 'build',
      predicate: 'started',
      version: '0.3.0',
      extension: false,
      wireType: 'dev.cdevents.build.started.0.3.0',
    });
  });

  it('colon exact is equivalent and normalizes to the embedded wire form', () => {
    const r = resolveEventType('dev.cdevents.build.started:0.1.1', cat);
    expect(r.version).toBe('0.1.1');
    expect(r.wireType).toBe('dev.cdevents.build.started.0.1.1');
  });

  it('versionless resolves to the latest release', () => {
    const r = resolveEventType('dev.cdevents.pipelinerun.started', cat);
    expect(r.version).toBe('0.3.0');
    expect(r.wireType).toBe('dev.cdevents.pipelinerun.started.0.3.0');
  });

  it('caret range picks the highest match within the caret bound', () => {
    // build.started versions: 0.1.1, 0.2.0, 0.3.0 — ^0.1.0 admits <0.2.0.
    expect(resolveEventType('dev.cdevents.build.started:^0.1.0', cat).version).toBe('0.1.1');
    expect(resolveEventType('dev.cdevents.build.started:^0.2.0', cat).version).toBe('0.2.0');
  });

  it('tilde, x-range, bare-prefix, and comparator ranges resolve', () => {
    expect(resolveEventType('dev.cdevents.build.started:~0.2.0', cat).version).toBe('0.2.0');
    expect(resolveEventType('dev.cdevents.build.started:0.x', cat).version).toBe('0.3.0');
    expect(resolveEventType('dev.cdevents.build.started:0.1', cat).version).toBe('0.1.1');
    expect(resolveEventType('dev.cdevents.build.started:*', cat).version).toBe('0.3.0');
    expect(resolveEventType('dev.cdevents.build.started:>=0.2.0', cat).version).toBe('0.3.0');
    expect(resolveEventType('dev.cdevents.build.started:<0.3.0', cat).version).toBe('0.2.0');
  });

  it('extension types pass through opaquely, versioned or not', () => {
    const versioned = resolveEventType('dev.cdeventsx.mytool-build.started.0.2.0', cat);
    expect(versioned).toMatchObject({
      subject: 'mytool-build',
      predicate: 'started',
      version: '',
      extension: true,
      wireType: 'dev.cdeventsx.mytool-build.started.0.2.0',
    });
    const bare = resolveEventType('dev.cdeventsx.mytool-notification.dispatched', cat);
    expect(bare.extension).toBe(true);
    expect(bare.wireType).toBe('dev.cdeventsx.mytool-notification.dispatched');
  });

  it('reports every §6.2 failure mode', () => {
    expect(() => resolveEventType('dev.cdevents.nosuch.thing', cat)).toThrow(
      /unknown CDEvent type nosuch\.thing/,
    );
    expect(() => resolveEventType('dev.cdevents.build.started.9.9.9', cat)).toThrow(
      /no version 9\.9\.9 of build\.started/,
    );
    expect(() => resolveEventType('dev.cdevents.build.started:^9.0.0', cat)).toThrow(
      /no version of build\.started satisfies/,
    );
    expect(() => resolveEventType('dev.cdevents.build.started:', cat)).toThrow(
      /empty version spec/,
    );
    expect(() => resolveEventType('dev.cdevents.build', cat)).toThrow(/malformed event type/);
    expect(() => resolveEventType('dev.cdeventsx.short', cat)).toThrow(/malformed extension type/);
  });

  it('rejects multi-comparator ranges as unauthorable', () => {
    const spaced = parseEventCatalog({ subjects: { build: { started: ['0.1.0'] } } });
    expect(() => resolveEventType('dev.cdevents.build.started:>=0.1.0 <0.2.0', spaced)).toThrow(
      /not authorable/,
    );
  });

  it('holds the standard semver prerelease posture', () => {
    const pre = parseEventCatalog({
      subjects: { build: { started: ['0.1.0-draft', '0.1.0', '0.2.0-rc.1'] } },
    });
    // Versionless skips prereleases while any release exists.
    expect(resolveEventType('dev.cdevents.build.started', pre).version).toBe('0.1.0');
    // A range admits a prerelease only when its own bound names that tuple's prerelease.
    expect(resolveEventType('dev.cdevents.build.started:^0.2.0-rc.1', pre).version).toBe(
      '0.2.0-rc.1',
    );
    expect(resolveEventType('dev.cdevents.build.started:^0.1.0', pre).version).toBe('0.1.0');
    // Only prereleases in the catalog: versionless falls back to the highest.
    const only = parseEventCatalog({ subjects: { build: { started: ['0.1.0-draft'] } } });
    expect(resolveEventType('dev.cdevents.build.started', only).version).toBe('0.1.0-draft');
  });
});

describe('subjectPredicateOfType — the catalog-free key parse', () => {
  it.each([
    ['dev.cdevents.build.started.0.3.0', 'build', 'started'],
    ['dev.cdevents.build.started:^0.1.0', 'build', 'started'],
    ['dev.cdevents.pipelinerun.started', 'pipelinerun', 'started'],
    ['dev.cdeventsx.mytool-build.started.0.2.0', 'mytool-build', 'started'],
    ['dev.cdeventsx.mytool-notification.dispatched', 'mytool-notification', 'dispatched'],
  ])('%s → %s.%s', (authored, subject, predicate) => {
    expect(subjectPredicateOfType(authored)).toEqual({ subject, predicate });
  });

  it('returns null for non-CDEvent identifiers', () => {
    expect(subjectPredicateOfType('not.a.type')).toBeNull();
    expect(subjectPredicateOfType('dev.other.build.started')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders numerically with prereleases before their release', () => {
    expect(compareVersions('0.2.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('0.1.0-draft', '0.1.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
});

// The judge model: conduit-go's copy is canonical; this vendored mirror must
// be byte-equal whenever the canonical repo is present. On drift, re-copy
// from canonical — never edit the mirror to disagree.
describe.skipIf(!existsSync(CANONICAL))('catalog sync-check (canonical: conduit-go)', () => {
  it('vendored catalog is byte-equal to canonical', () => {
    expect(readFileSync(VENDORED, 'utf-8')).toBe(readFileSync(CANONICAL, 'utf-8'));
  });
});
