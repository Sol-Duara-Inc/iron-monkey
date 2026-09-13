/**
 * @module catalog/store
 * The catalog: one directory holding the documents this producer can pitch by
 * name, in the same shape the authority keeps them — `<id>.workflow.yaml` and
 * `<group>.<author>.<expression>.expression.yaml`, both globs over one root.
 *
 * Three rules, each paid for by a failure we have actually seen:
 *
 * **Identity comes from the CONTENT, never the filename.** A file named
 * `solduara.dsanyika.build.expression.yaml` declaring group `sol-duara` is a
 * lie the filename tells; indexing by filename would believe it.
 *
 * **A duplicate identity is an error, not a race.** The expression registry
 * indexes same-identity bundles twice and resolves whichever `readdir`
 * returned first — so editing one of two copies silently changes which
 * document expands, decided by filesystem order. Here, two files claiming one
 * identity is reported with both paths.
 *
 * **Nothing throws at INDEX time.** `loadExpressionRegistry` runs on every
 * run, and this store is consulted the same way; a catalog that failed loudly
 * at load would let one malformed file break a pure hand-in run that never
 * touched the catalog. So indexing records problems and lookup raises them —
 * only for the identity actually asked for.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { parseYaml } from '../util/yaml-file.js';
import { getLogger } from '../logger/index.js';

/** One indexed document. */
export interface CatalogEntry {
  kind: 'workflow' | 'expression';
  /** Identity read from the document body. */
  id: string;
  /** Absolute path of the file it was read from. */
  file: string;
  /** True when the filename does not match the identity's canonical spelling. */
  misnamed: boolean;
}

/** A file the index could not use, raised only if its identity is requested. */
export interface CatalogProblem {
  file: string;
  message: string;
}

/** A loaded catalog index. */
export interface Catalog {
  /** The root directory this was built from. */
  dir: string;
  /** Every unambiguous entry, sorted by kind then id. */
  list(): CatalogEntry[];
  /**
   * The file backing one identity.
   *
   * @throws {Error} When the identity is unknown or ambiguous.
   */
  resolve(kind: 'workflow' | 'expression', id: string): string;
  /** Files that could not be indexed — surfaced by `catalog verify`. */
  problems(): CatalogProblem[];
  /** Identities claimed by more than one file. */
  conflicts(): { id: string; files: string[] }[];
}

/** Canonical filename for an identity, per the CDrus naming convention. */
export function canonicalFileName(kind: 'workflow' | 'expression', id: string): string {
  return kind === 'workflow' ? `${id}.workflow.yaml` : `${id.split('/').join('.')}.expression.yaml`;
}

function identityOf(kind: 'workflow' | 'expression', doc: unknown): string | null {
  if (doc === null || typeof doc !== 'object') return null;
  const d = doc as Record<string, unknown>;
  if (kind === 'workflow') {
    const w = d.workflow as Record<string, unknown> | undefined;
    return typeof w?.id === 'string' ? w.id : null;
  }
  const { group, author, expression } = d;
  if (typeof group !== 'string' || typeof author !== 'string' || typeof expression !== 'string') {
    return null;
  }
  return `${group}/${author}/${expression}`;
}

/**
 * Indexes a catalog directory. Never throws: a missing directory yields an
 * empty catalog, and an unreadable file becomes a problem entry.
 */
export function loadCatalog(dir: string): Catalog {
  const entries = new Map<string, CatalogEntry[]>();
  const problems: CatalogProblem[] = [];
  const key = (kind: string, id: string): string => `${kind} ${id}`;

  if (existsSync(dir)) {
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch (err) {
      problems.push({ file: dir, message: (err as Error).message });
    }

    for (const name of files) {
      const kind: 'workflow' | 'expression' | null = name.endsWith('.workflow.yaml')
        ? 'workflow'
        : name.endsWith('.expression.yaml')
          ? 'expression'
          : null;
      // The suffix is the opt-in: a stray .yaml here is not a catalog entry,
      // so leaving notes beside the corpus cannot publish them by accident.
      if (kind === null) continue;

      const file = path.join(dir, name);
      let doc: unknown;
      try {
        doc = parseYaml(readFileSync(file, 'utf-8'), (cause) => `${cause}`);
      } catch (err) {
        problems.push({ file, message: `unparseable: ${(err as Error).message}` });
        continue;
      }

      const id = identityOf(kind, doc);
      if (id === null) {
        problems.push({ file, message: `no ${kind} identity in the document body` });
        continue;
      }

      const list = entries.get(key(kind, id)) ?? [];
      list.push({ kind, id, file, misnamed: name !== canonicalFileName(kind, id) });
      entries.set(key(kind, id), list);
    }
  }

  return {
    dir,
    list() {
      return [...entries.values()]
        .filter((v) => v.length === 1)
        .map((v) => v[0])
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    },

    resolve(kind, id) {
      const found = entries.get(key(kind, id));
      if (found === undefined || found.length === 0) {
        throw new Error(
          `unknown ${kind} '${id}' in catalog ${dir}. ` +
            `Run 'iron-monkey catalog list' to see what is there.`,
        );
      }
      if (found.length > 1) {
        const names = found.map((f) => path.basename(f.file)).join(', ');
        throw new Error(
          `ambiguous ${kind} '${id}': ${found.length} files in ${dir} claim that identity ` +
            `(${names}). Identity comes from the document body, so renaming a file does ` +
            `not separate them — delete or re-identify one.`,
        );
      }
      if (found[0].misnamed) {
        getLogger().warn(
          { file: found[0].file, expected: canonicalFileName(kind, id), id },
          'catalog entry filename does not match its declared identity',
        );
      }
      return found[0].file;
    },

    problems: () => [...problems],

    conflicts: () =>
      [...entries.values()]
        .filter((v) => v.length > 1)
        .map((v) => ({ id: v[0].id, files: v.map((e) => e.file) })),
  };
}
