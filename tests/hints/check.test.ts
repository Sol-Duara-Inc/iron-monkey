import { describe, it, expect } from 'vitest';
import {
  tokenizeName,
  subjectPredicateOf,
  extractHints,
  spellingDiagnostics,
  checkNameHints,
} from '../../src/hints/check.js';
import type { HintTable } from '../../src/hints/types.js';

/** Fixed table so these tests cannot drift with the shipped data file. */
const TABLE: HintTable = {
  version: '0.1.0',
  subjects: {
    build: { predicates: ['finished', 'queued', 'started'], begin: 'started', end: 'finished' },
    change: {
      predicates: ['abandoned', 'created', 'merged', 'reviewed', 'updated'],
      begin: null,
      end: null,
    },
    ticket: { predicates: ['closed', 'created', 'updated'], begin: null, end: null },
    testcaserun: {
      predicates: ['finished', 'queued', 'skipped', 'started'],
      begin: 'started',
      end: 'finished',
    },
    pipelinerun: {
      predicates: ['finished', 'queued', 'started'],
      begin: 'started',
      end: 'finished',
    },
    testoutput: { predicates: ['published'], begin: null, end: null },
  },
};

const ev = (event: string) => ({ event });

// ── tokenizeName ──────────────────────────────────────────────────────────────

describe('tokenizeName', () => {
  it('splits on hyphens', () => {
    expect(tokenizeName('build-deploy')).toEqual(['build', 'deploy']);
  });

  it('returns a single token for an unhyphenated name', () => {
    expect(tokenizeName('build')).toEqual(['build']);
  });

  it('drops empty tokens', () => {
    expect(tokenizeName('a--b')).toEqual(['a', 'b']);
  });
});

// ── subjectPredicateOf ────────────────────────────────────────────────────────

describe('subjectPredicateOf', () => {
  it('parses the canonical embedded-version form', () => {
    expect(subjectPredicateOf('dev.cdevents.build.started.0.3.0')).toEqual({
      subject: 'build',
      predicate: 'started',
    });
  });

  it('parses the colon exact and range forms', () => {
    expect(subjectPredicateOf('dev.cdevents.build.started:0.1.1')).toEqual({
      subject: 'build',
      predicate: 'started',
    });
    expect(subjectPredicateOf('dev.cdevents.build.started:^0.1.0')).toEqual({
      subject: 'build',
      predicate: 'started',
    });
  });

  it('parses the versionless form', () => {
    expect(subjectPredicateOf('dev.cdevents.change.merged')).toEqual({
      subject: 'change',
      predicate: 'merged',
    });
  });

  it('parses extended types with their literal extended subject', () => {
    expect(subjectPredicateOf('dev.cdeventsx.mytool-build.started.0.2.0')).toEqual({
      subject: 'mytool-build',
      predicate: 'started',
    });
  });

  it('returns null for non-CDEvent strings', () => {
    expect(subjectPredicateOf('not.an.event.type')).toBeNull();
    expect(subjectPredicateOf('dev.cdevents.build')).toBeNull();
    expect(subjectPredicateOf('')).toBeNull();
  });
});

// ── extractHints: exact-token matching ────────────────────────────────────────

describe('extractHints — exact-token matching', () => {
  it('matches a subject as a delimited interior token', () => {
    expect(extractHints('my-testcaserun-job', TABLE)).toEqual(['testcaserun']);
  });

  it('does not match a hyphenated spelling of a subject', () => {
    expect(extractHints('my-test-case-run-job', TABLE)).toEqual([]);
  });

  it('does not match substring occurrences inside a single token', () => {
    expect(extractHints('mytestcaserunjob', TABLE)).toEqual([]);
    expect(extractHints('rebuild', TABLE)).toEqual([]);
    expect(extractHints('buildpack', TABLE)).toEqual([]);
  });

  it('does not match partial hyphenated fragments', () => {
    expect(extractHints('my-test-case-job', TABLE)).toEqual([]);
    expect(extractHints('my-test-run-job', TABLE)).toEqual([]);
  });

  it('matches the whole name, leading, and trailing positions', () => {
    expect(extractHints('build', TABLE)).toEqual(['build']);
    expect(extractHints('build-then-notify', TABLE)).toEqual(['build']);
    expect(extractHints('nightly-build', TABLE)).toEqual(['build']);
  });

  it('collects multiple hints and deduplicates repeats', () => {
    expect(extractHints('build-change', TABLE)).toEqual(['build', 'change']);
    expect(extractHints('build-x-build', TABLE)).toEqual(['build']);
  });

  it('carries no hint when no token is a subject', () => {
    expect(extractHints('my-favorite-expression', TABLE)).toEqual([]);
    expect(extractHints('deploy', TABLE)).toEqual([]); // 'deploy' is not a CDEvents subject
  });

  it('does not treat Object prototype keys as subjects (own-key matching only)', () => {
    // `'constructor' in table.subjects` is true via the prototype chain; a
    // phantom hint here would make the name unsatisfiable and reject the doc.
    expect(extractHints('my-constructor-job', TABLE)).toEqual([]);
    expect(extractHints('to-string-valueof-hasownproperty', TABLE)).toEqual([]);
    const result = checkNameHints(
      { expression: 'my-constructor-job', produces: [ev('dev.cdevents.change.created')] },
      TABLE,
    );
    expect(result.ok).toBe(true);
    expect(result.hints).toEqual([]);
  });
});

// ── spellingDiagnostics ───────────────────────────────────────────────────────

describe('spellingDiagnostics', () => {
  it('warns when a token run spells a subject', () => {
    const diags = spellingDiagnostics('my-test-case-run-job', TABLE);
    expect(diags).toHaveLength(1);
    expect(diags[0].subject).toBe('testcaserun');
    expect(diags[0].tokens).toEqual(['test', 'case', 'run']);
    expect(diags[0].message).toContain("did you mean 'testcaserun'?");
  });

  it('warns for two-token spellings', () => {
    expect(spellingDiagnostics('pipeline-run', TABLE)[0]?.subject).toBe('pipelinerun');
    expect(spellingDiagnostics('test-output-publish', TABLE)[0]?.subject).toBe('testoutput');
  });

  it('does not warn for an exact single-token hint', () => {
    expect(spellingDiagnostics('my-testcaserun-job', TABLE)).toEqual([]);
  });

  it('does not warn when no run spells a subject', () => {
    expect(spellingDiagnostics('my-test-case-job', TABLE)).toEqual([]);
    expect(spellingDiagnostics('my-test-run-job', TABLE)).toEqual([]);
  });

  it('does not warn when a token run spells an Object prototype key', () => {
    expect(spellingDiagnostics('construc-tor', TABLE)).toEqual([]);
    expect(spellingDiagnostics('has-own-property', TABLE)).toEqual([]);
  });
});

// ── checkNameHints: satisfaction ──────────────────────────────────────────────

describe('checkNameHints — local satisfaction', () => {
  it('accepts a paired hint with both begin and end events', () => {
    const result = checkNameHints(
      {
        expression: 'build',
        produces: [
          ev('dev.cdevents.build.queued.0.3.0'),
          ev('dev.cdevents.build.started.0.3.0'),
          ev('dev.cdevents.build.finished.0.3.0'),
        ],
      },
      TABLE,
    );
    expect(result.ok).toBe(true);
    expect(result.hints).toEqual(['build']);
    expect(result.violations).toEqual([]);
  });

  it('rejects a paired hint missing the end event', () => {
    const result = checkNameHints(
      {
        expression: 'build-queue',
        produces: [ev('dev.cdevents.build.queued.0.3.0'), ev('dev.cdevents.build.started.0.3.0')],
      },
      TABLE,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].hint).toBe('build');
    expect(result.violations[0].paired).toBe(true);
    expect(result.violations[0].requires).toEqual(['build.started', 'build.finished']);
    expect(result.violations[0].found).toEqual(['build.queued', 'build.started']);
  });

  it('accepts a flat hint with any one subject event', () => {
    const result = checkNameHints(
      { expression: 'change-request', produces: [ev('dev.cdevents.change.merged.0.3.0')] },
      TABLE,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a flat hint with no subject event', () => {
    const result = checkNameHints(
      { expression: 'ticket-trail', produces: [ev('dev.cdevents.change.created.0.3.0')] },
      TABLE,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0].hint).toBe('ticket');
    expect(result.violations[0].paired).toBe(false);
  });

  it('counts events declared in nested produces and detach bodies', () => {
    const result = checkNameHints(
      {
        expression: 'build',
        produces: [
          {
            event: 'dev.cdevents.build.started.0.3.0',
            produces: [ev('dev.cdevents.change.merged.0.3.0')],
            detach: [[ev('dev.cdevents.build.finished.0.3.0')]],
          },
        ],
      },
      TABLE,
    );
    expect(result.ok).toBe(true);
  });

  it('accepts colon and versionless event forms', () => {
    const result = checkNameHints(
      {
        expression: 'build',
        produces: [ev('dev.cdevents.build.started:^0.1.0'), ev('dev.cdevents.build.finished')],
      },
      TABLE,
    );
    expect(result.ok).toBe(true);
  });

  it('does not let an extended type satisfy a core subject hint', () => {
    const result = checkNameHints(
      {
        expression: 'build',
        produces: [
          ev('dev.cdeventsx.mytool-build.started.0.2.0'),
          ev('dev.cdeventsx.mytool-build.finished.0.2.0'),
        ],
      },
      TABLE,
    );
    expect(result.ok).toBe(false);
  });
});

describe('checkNameHints — delegation (shallow-static)', () => {
  it('accepts a hint satisfied by a reference whose name carries the token', () => {
    const result = checkNameHints(
      { expression: 'build-deploy', produces: [{ expression: 'build' }, { expression: 'deploy' }] },
      TABLE,
    );
    expect(result.ok).toBe(true);
  });

  it('accepts delegation through a fully qualified reference (final segment)', () => {
    const result = checkNameHints(
      {
        expression: 'nightly-build',
        produces: [{ expression: 'payment-engineering/mchen/build' }],
      },
      TABLE,
    );
    expect(result.ok).toBe(true);
  });

  it('ignores group and author path segments for delegation', () => {
    // The group is literally named 'build' — that must contribute nothing.
    const result = checkNameHints(
      { expression: 'nightly-build', produces: [{ expression: 'build/jdoe/notify' }] },
      TABLE,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects when events exist only in an unexpanded reference without the token', () => {
    // The events-in-expansion-but-no-token vector: shallow-static never expands.
    const result = checkNameHints(
      { expression: 'build', produces: [{ expression: 'compile-all' }] },
      TABLE,
    );
    expect(result.ok).toBe(false);
  });
});

describe('checkNameHints — hint-free and diagnostic-only names', () => {
  it('constrains nothing when the name carries no hint', () => {
    const result = checkNameHints(
      { expression: 'my-favorite-expression', produces: [ev('dev.cdevents.change.created')] },
      TABLE,
    );
    expect(result.ok).toBe(true);
    expect(result.hints).toEqual([]);
  });

  it('accepts with a diagnostic when a token run spells a subject', () => {
    const result = checkNameHints(
      { expression: 'my-test-case-run-job', produces: [ev('dev.cdevents.change.created')] },
      TABLE,
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].subject).toBe('testcaserun');
  });

  it('never throws on malformed produces shapes', () => {
    expect(checkNameHints({ expression: 'build', produces: null }, TABLE).ok).toBe(false);
    expect(checkNameHints({ expression: 'build', produces: 42 }, TABLE).ok).toBe(false);
    expect(
      checkNameHints({ expression: 'anything', produces: [{ junk: true }, null, 'str'] }, TABLE).ok,
    ).toBe(true);
  });
});
