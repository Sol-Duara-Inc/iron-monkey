/**
 * @module hints/check
 * Pure name-hint checker for CDrus Expressions (RFC §4.1.1), shallow-static
 * semantics with exact-token matching.
 *
 * The rule: CDEvent subjects are reserved keywords in an expression name. A
 * name token that is exactly equal to a subject (delimited by hyphens or the
 * name's start/end) is a hint. A hint on subject `s` is satisfied when either:
 *
 * - (a) locally — the event items declared anywhere in the literal document
 *   (top-level `produces`, nested `produces`, `spawn` and `detach` bodies)
 *   contain the required events: both the begin and end predicates for a
 *   paired subject, at least one event of `s` otherwise; or
 * - (b) by delegation — some expression reference in the document has an
 *   expression token (the final path component only, never group or author)
 *   that itself carries `s` as a delimited token.
 *
 * Satisfaction is determined solely by the document text: references are
 * never resolved or expanded. Substring occurrences are not tokens
 * (`rebuild`, `buildpack` carry no hint), and matching is exact — the
 * hyphenated spelling `test-case-run` does NOT match the subject
 * `testcaserun`; it produces an advisory diagnostic instead.
 */

import type {
  HintCheckInput,
  HintCheckResult,
  HintDiagnostic,
  HintTable,
  HintViolation,
} from './types.js';

/**
 * Splits an identity token into its hyphen-delimited name tokens.
 *
 * @param name - An identity component such as `'build-deploy'`.
 * @returns The non-empty tokens in order, e.g. `['build', 'deploy']`.
 */
export function tokenizeName(name: string): string[] {
  return name.split('-').filter((t) => t.length > 0);
}

/**
 * Extracts the `subject.predicate` pair from a CDEvent type string, tolerant
 * of every syntactic form the CDrus schemas accept: embedded version
 * (`dev.cdevents.build.started.0.3.0`), colon version or range
 * (`dev.cdevents.build.started:^0.1.0`), versionless, and extended
 * (`dev.cdeventsx.mytool-build.started` — whose subject is the literal
 * `mytool-build` token and therefore never equals a core subject).
 *
 * @param eventType - The `event` field value.
 * @returns The subject/predicate pair, or null when the string is not a
 *   recognizable CDEvent type.
 */
export function subjectPredicateOf(
  eventType: string,
): { subject: string; predicate: string } | null {
  const versionless = eventType.split(':')[0];
  const parts = versionless.split('.');
  if (parts.length < 4 || parts[0] !== 'dev') return null;
  if (parts[1] !== 'cdevents' && parts[1] !== 'cdeventsx') return null;
  return { subject: parts[2], predicate: parts[3] };
}

/**
 * Returns the hint subjects an expression name carries: every name token that
 * is exactly equal to a subject in the table, in name order, deduplicated.
 *
 * @param name - The expression name component.
 * @param table - The keyword table to match against.
 */
export function extractHints(name: string, table: HintTable): string[] {
  const seen = new Set<string>();
  const hints: string[] = [];
  for (const token of tokenizeName(name)) {
    if (token in table.subjects && !seen.has(token)) {
      seen.add(token);
      hints.push(token);
    }
  }
  return hints;
}

/**
 * Finds runs of two or more consecutive name tokens whose concatenation
 * spells a subject (`test-case-run` → `testcaserun`). Advisory only: such a
 * run is NOT a hint under exact-token matching, but almost certainly reflects
 * author intent, so it deserves a "did you mean" warning.
 *
 * @param name - The expression name component.
 * @param table - The keyword table to match against.
 */
export function spellingDiagnostics(name: string, table: HintTable): HintDiagnostic[] {
  const tokens = tokenizeName(name);
  const diagnostics: HintDiagnostic[] = [];
  for (let start = 0; start < tokens.length; start++) {
    for (let end = start + 2; end <= tokens.length; end++) {
      const run = tokens.slice(start, end);
      const spelled = run.join('');
      if (spelled in table.subjects) {
        diagnostics.push({
          kind: 'hyphenated-subject',
          tokens: run,
          subject: spelled,
          message:
            `name tokens '${run.join('-')}' spell the CDEvents subject '${spelled}' but do not ` +
            `constitute a hint under exact-token matching — did you mean '${spelled}'?`,
        });
      }
    }
  }
  return diagnostics;
}

/** Events and reference tokens gathered from one literal document. */
interface DocumentFacts {
  /** Every `subject.predicate` declared by an event item anywhere in the document. */
  events: Set<string>;
  /** Every hyphen token of every expression reference's final path component. */
  refTokens: Set<string>;
}

/** The chain-bearing keys an item may carry; all are walked uniformly. */
const CHAIN_KEYS = ['produces', 'spawn', 'detach'] as const;

/**
 * Structurally walks a literal `produces` tree, collecting event
 * subject/predicate pairs and expression-reference name tokens. Arrays recurse
 * (covering nested spawned-chain lists), objects contribute their `event` or
 * `expression` field and recurse into `produces`/`spawn`/`detach`. Unknown
 * shapes are ignored — the checker never throws on malformed input; malformed
 * documents are the schema validator's concern.
 */
function collectFacts(node: unknown, facts: DocumentFacts): void {
  if (Array.isArray(node)) {
    for (const item of node) collectFacts(item, facts);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const item = node as Record<string, unknown>;

  if (typeof item.event === 'string') {
    const sp = subjectPredicateOf(item.event);
    if (sp) facts.events.add(`${sp.subject}.${sp.predicate}`);
  }
  if (typeof item.expression === 'string') {
    const finalSegment = item.expression.split('/').pop() ?? '';
    for (const token of tokenizeName(finalSegment)) facts.refTokens.add(token);
  }
  for (const key of CHAIN_KEYS) {
    if (Array.isArray(item[key])) collectFacts(item[key], facts);
  }
}

/**
 * Checks one expression document against the name-hint rule.
 *
 * Violations are normative (a store MUST reject, a loader MUST report);
 * diagnostics are advisory and never affect `ok`.
 *
 * @param doc - The expression name and literal `produces` tree.
 * @param table - The keyword table (versioned data) to evaluate against.
 * @returns Hints carried, violations, and diagnostics.
 */
export function checkNameHints(doc: HintCheckInput, table: HintTable): HintCheckResult {
  const name = doc.expression;
  const hints = extractHints(name, table);
  const diagnostics = spellingDiagnostics(name, table);
  const violations: HintViolation[] = [];

  if (hints.length > 0) {
    const facts: DocumentFacts = { events: new Set(), refTokens: new Set() };
    collectFacts(doc.produces, facts);

    for (const hint of hints) {
      const subject = table.subjects[hint];
      const paired = subject.begin !== null && subject.end !== null;
      const delegated = facts.refTokens.has(hint);
      const found = [...facts.events].filter((e) => e.startsWith(`${hint}.`)).sort();

      const satisfied = paired
        ? delegated ||
          (facts.events.has(`${hint}.${subject.begin}`) &&
            facts.events.has(`${hint}.${subject.end}`))
        : delegated || found.length > 0;

      if (!satisfied) {
        const requires = paired
          ? [`${hint}.${subject.begin}`, `${hint}.${subject.end}`]
          : subject.predicates.map((p) => `${hint}.${p}`);
        violations.push({
          hint,
          paired,
          requires,
          found,
          message: paired
            ? `name hint '${hint}' requires both '${hint}.${subject.begin}' and ` +
              `'${hint}.${subject.end}' in produces (or a reference whose name carries ` +
              `'${hint}'); found: ${found.length ? found.join(', ') : 'none'}`
            : `name hint '${hint}' requires at least one '${hint}.*' event in produces ` +
              `(or a reference whose name carries '${hint}'); found: none`,
        });
      }
    }
  }

  return { name, hints, violations, diagnostics, ok: violations.length === 0 };
}
