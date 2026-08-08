import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadHintTable, parseHintTable } from '../../src/hints/table.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CDEVENTS_DIR = path.resolve(__dirname, '../../schemas/cdevents');

// ── default table ─────────────────────────────────────────────────────────────

describe('loadHintTable — bundled default', () => {
  it('loads and validates the shipped table', () => {
    const table = loadHintTable();
    expect(table.version).toBe('0.1.0');
    expect(Object.keys(table.subjects).length).toBeGreaterThan(0);
  });

  it('classifies build as paired started/finished', () => {
    const table = loadHintTable();
    expect(table.subjects.build).toEqual({
      predicates: ['finished', 'queued', 'started'],
      begin: 'started',
      end: 'finished',
    });
  });

  it('classifies artifact as flat', () => {
    const table = loadHintTable();
    expect(table.subjects.artifact.begin).toBeNull();
    expect(table.subjects.artifact.end).toBeNull();
  });

  it('throws a clear error for a missing file', () => {
    expect(() => loadHintTable('/nonexistent/table.json')).toThrow(/Cannot read name-hint table/);
  });
});

// ── shape validation ──────────────────────────────────────────────────────────

describe('parseHintTable — shape validation', () => {
  const subject = { predicates: ['started', 'finished'], begin: 'started', end: 'finished' };

  it('rejects non-objects', () => {
    expect(() => parseHintTable(null)).toThrow(/JSON object/);
    expect(() => parseHintTable([])).toThrow(/JSON object/);
  });

  it('requires a string version', () => {
    expect(() => parseHintTable({ subjects: {} })).toThrow(/version/);
    expect(() => parseHintTable({ version: 1, subjects: {} })).toThrow(/version/);
  });

  it('requires a subjects object', () => {
    expect(() => parseHintTable({ version: '0.1.0' })).toThrow(/subjects/);
    expect(() => parseHintTable({ version: '0.1.0', subjects: [] })).toThrow(/subjects/);
  });

  it('requires each subject to declare string predicates', () => {
    expect(() =>
      parseHintTable({ version: '0.1.0', subjects: { build: { predicates: [1] } } }),
    ).toThrow(/predicates/);
    expect(() => parseHintTable({ version: '0.1.0', subjects: { build: null } })).toThrow(
      /must be an object/,
    );
  });

  it('rejects explicit empty-string begin/end', () => {
    expect(() =>
      parseHintTable({
        version: '0.1.0',
        subjects: { build: { ...subject, begin: '' } },
      }),
    ).toThrow(/'begin' must be a non-empty string or null/);
    expect(() =>
      parseHintTable({
        version: '0.1.0',
        subjects: { build: { ...subject, end: '' } },
      }),
    ).toThrow(/'end' must be a non-empty string or null/);
  });

  it('requires begin and end to be paired', () => {
    expect(() =>
      parseHintTable({
        version: '0.1.0',
        subjects: { build: { ...subject, end: null } },
      }),
    ).toThrow(/paired/);
    expect(() =>
      parseHintTable({
        version: '0.1.0',
        subjects: { build: { ...subject, begin: 5 } },
      }),
    ).toThrow(/'begin' must be a non-empty string or null/);
  });

  it('accepts a well-formed table and normalizes missing begin/end to null', () => {
    const table = parseHintTable({
      version: '0.2.0',
      subjects: { thing: { predicates: ['done'] } },
    });
    expect(table.subjects.thing).toEqual({ predicates: ['done'], begin: null, end: null });
  });
});

// ── drift sentinel ────────────────────────────────────────────────────────────

describe('name-hint table — drift against the CDEvents catalog', () => {
  it('matches the subjects and predicates derivable from schemas/cdevents', () => {
    // Re-derive the table from the catalog the same way it was generated:
    // subject/predicate from each schema's context.type, paired iff the
    // predicate set contains both 'started' and 'finished'. If a CDEvents
    // release adds or changes subjects, this test fails until the table is
    // bumped via a reviewed version change — the table must never drift
    // silently (RFC §4.1.1: table updates are deliberate, not automatic).
    const derived = new Map<string, Set<string>>();
    for (const file of readdirSync(CDEVENTS_DIR)) {
      if (!file.endsWith('.json')) continue;
      const schema = JSON.parse(readFileSync(path.join(CDEVENTS_DIR, file), 'utf-8')) as {
        properties?: {
          context?: { properties?: { type?: { enum?: string[]; default?: string } } };
        };
      };
      const typeDecl = schema.properties?.context?.properties?.type;
      const type = typeDecl?.enum?.[0] ?? typeDecl?.default;
      if (!type || !type.startsWith('dev.cdevents.')) continue;
      const [, , subject, predicate] = type.split('.');
      if (!derived.has(subject)) derived.set(subject, new Set());
      derived.get(subject)!.add(predicate);
    }

    const table = loadHintTable();
    expect(Object.keys(table.subjects).sort()).toEqual([...derived.keys()].sort());

    for (const [subject, predicates] of derived) {
      const entry = table.subjects[subject];
      expect(entry.predicates).toEqual([...predicates].sort());
      const paired = predicates.has('started') && predicates.has('finished');
      expect(entry.begin).toBe(paired ? 'started' : null);
      expect(entry.end).toBe(paired ? 'finished' : null);
    }
  });
});

describe('loadHintTable — unparsable file', () => {
  it('throws a clear parse error for invalid JSON', async () => {
    const { writeFile } = await import('fs/promises');
    const { makeTmpDir } = await import('../helpers.js');
    const dir = await makeTmpDir('im-hint-table');
    const bad = path.join(dir, 'broken.json');
    await writeFile(bad, '{ not json', 'utf-8');
    expect(() => loadHintTable(bad)).toThrow(/Failed to parse name-hint table/);
  });
});
