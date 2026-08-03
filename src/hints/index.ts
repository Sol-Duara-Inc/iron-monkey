/**
 * @module hints
 * CDrus name-hint checking (RFC §4.1.1): exact-token hint extraction,
 * shallow-static satisfaction with delegation, and advisory diagnostics.
 *
 * This module is an isolable library — it imports nothing from the rest of
 * Iron Monkey and receives the keyword table as data. See `types.ts` for the
 * boundary rules.
 */

export {
  tokenizeName,
  subjectPredicateOf,
  extractHints,
  spellingDiagnostics,
  checkNameHints,
} from './check.js';
export { loadHintTable, parseHintTable } from './table.js';
export type {
  HintTable,
  HintSubject,
  HintCheckInput,
  HintCheckResult,
  HintViolation,
  HintDiagnostic,
} from './types.js';
