/**
 * @module hints/types
 * Types for the CDrus name-hint checker (RFC §4.1.1).
 *
 * ISOLATION BOUNDARY: the `src/hints` module is an isolable library. Nothing
 * in this directory may import from any other `src/` module — the checker is
 * pure, the keyword table is passed in as data, and the only runtime
 * dependency (`fs`, in `table.ts`) is for loading the bundled default table.
 * Keep it that way: this module is slated for extraction into a standalone
 * package once the RFC stabilises.
 */

/** One CDEvents subject entry in the keyword table. */
export interface HintSubject {
  /** The subject's full predicate set, from the CDEvents catalog. */
  predicates: string[];
  /** Begin predicate of the subject's begin/end pair, or null for a flat-predicate subject. */
  begin: string | null;
  /** End predicate of the subject's begin/end pair, or null for a flat-predicate subject. */
  end: string | null;
}

/**
 * The versioned name-hint keyword table (RFC §4.1.1). Hint evaluation is
 * performed against a declared table version; acceptance is determined by
 * exact token match against `subjects` keys and nothing else.
 */
export interface HintTable {
  /** Table version. Governs new publications; never applied retroactively. */
  version: string;
  /** CDEvents subjects, keyed by subject name (unhyphenated, lowercase). */
  subjects: Record<string, HintSubject>;
}

/**
 * A hint the expression name carries but the document does not satisfy.
 * Violations are normative: a conformant store MUST reject the document and a
 * conformant loader MUST report it.
 */
export interface HintViolation {
  /** The subject token that constitutes the hint. */
  hint: string;
  /** True when the subject has a begin/end predicate pair. */
  paired: boolean;
  /**
   * What satisfaction requires, as `subject.predicate` keys — both members of
   * the begin/end pair for a paired subject, any one subject event otherwise.
   */
  requires: string[];
  /** The `subject.predicate` keys of that subject actually found in the document. */
  found: string[];
  /** Human-readable explanation. */
  message: string;
}

/**
 * A non-normative advisory finding. Diagnostics never affect acceptance —
 * the spec owns the verdict, implementations own the advice.
 */
export interface HintDiagnostic {
  /** Diagnostic kind. `hyphenated-subject`: a run of name tokens spells a subject. */
  kind: 'hyphenated-subject';
  /** The consecutive name tokens involved. */
  tokens: string[];
  /** The subject the tokens spell when concatenated. */
  subject: string;
  /** Human-readable explanation. */
  message: string;
}

/**
 * The minimal structural shape of a CDrus Expression document the checker
 * needs. Deliberately not Iron Monkey's `ExpressionBundle` type — the checker
 * accepts anything with an `expression` name and a `produces` tree.
 */
export interface HintCheckInput {
  /** The expression name component of the identity tuple. */
  expression: string;
  /** The literal `produces` array. Walked structurally; unknown shapes are ignored. */
  produces: unknown;
}

/** Result of checking one expression document against the hint rule. */
export interface HintCheckResult {
  /** The expression name that was checked. */
  name: string;
  /** Hint subjects the name carries (exact-token matches), in name order. */
  hints: string[];
  /** Unsatisfied hints. Empty when the document is acceptable. */
  violations: HintViolation[];
  /** Advisory findings. Never affect acceptance. */
  diagnostics: HintDiagnostic[];
  /** True when there are no violations (diagnostics do not affect this). */
  ok: boolean;
}
