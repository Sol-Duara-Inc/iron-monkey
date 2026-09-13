/**
 * @module catalog/ref
 * The one place that decides what a reference STRING means.
 *
 * A token is a catalog reference if and only if its first 8 bytes are exactly
 * `catalog:`. Everything else is a filesystem path, handed on untouched. There
 * is no fallback in either direction — a `catalog:` token is never stat'd, and
 * a path is never retried as a catalog id, not even after it fails to open.
 *
 * Why a literal prefix rather than a URI-scheme pattern: `notes:draft.yaml` is
 * a legal relative path that Iron Monkey accepts today, and a scheme regex
 * (`^[a-z][a-z0-9+.-]*:`) would turn it into a hard error. Handing in a
 * workflow must not be hampered, so the test that costs hand-in nothing is the
 * one that wins. The only spelling an 8-byte literal can shadow is a file
 * literally named `catalog:…`, whose escape is `./catalog:…`.
 *
 * The remainder is then VALIDATED, never re-interpreted. Catalog identities
 * are path-safe by grammar — `schemas/cdrus/workflow.schema.json` constrains a
 * workflow id to `^[a-z][a-z0-9-]*$` precisely because it is "used directly as
 * a storage-path segment" — so no id can contain `.`, `/`, `:` or `..`. A
 * remainder that is not a legal id is an error naming the two legal shapes; it
 * is never quietly treated as a path.
 */

/** The exact, case-sensitive token prefix. Eight bytes, colon included. */
export const CATALOG_SCHEME = 'catalog:';

/** A workflow id: the `workflow.id` grammar from the CDrus schema. */
const WORKFLOW_ID = /^[a-z][a-z0-9-]*$/;

/** An expression identity: `group/author/expression`, each the same grammar. */
const EXPRESSION_ID = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*){2}$/;

/** What a `catalog:` token names. */
export type CatalogRefKind = 'workflow' | 'expression';

/** A parsed catalog reference. */
export interface CatalogRef {
  kind: CatalogRefKind;
  /** The identity after the scheme: a workflow id, or `group/author/expression`. */
  id: string;
}

/**
 * The entire decision. Runs before any filesystem or index access, so the
 * answer cannot change with the working directory, with what happens to exist
 * on disk, or with what the catalog currently holds.
 */
export function isCatalogRef(token: string): boolean {
  return token.startsWith(CATALOG_SCHEME);
}

/**
 * Parses a `catalog:` token. Slash count decides the kind, and the grammar
 * guarantees the count: no identity component may contain a slash.
 *
 * @throws {Error} When the remainder matches neither legal shape. It is never
 *   retried as a path — a catalog reference that is malformed is a mistake to
 *   report, not a filename to guess at.
 */
export function parseCatalogRef(token: string): CatalogRef {
  if (!isCatalogRef(token)) {
    throw new Error(`not a catalog reference: '${token}'`);
  }
  const id = token.slice(CATALOG_SCHEME.length);
  if (WORKFLOW_ID.test(id)) return { kind: 'workflow', id };
  if (EXPRESSION_ID.test(id)) return { kind: 'expression', id };
  throw new Error(
    `malformed catalog reference '${token}': the part after '${CATALOG_SCHEME}' must be ` +
      `a workflow id ('my-pipeline') or an expression identity ` +
      `('group/author/expression'), lowercase with hyphens. ` +
      `To run a FILE by that name, pass its path instead — without the ` +
      `'${CATALOG_SCHEME}' prefix.`,
  );
}
