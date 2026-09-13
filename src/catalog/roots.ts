/**
 * @module catalog/roots
 * Where the catalog lives. ONE root, resolved in a fixed order — deliberately
 * not a search path.
 *
 * A search path would reintroduce the failure this whole design exists to
 * remove: two documents under one identity, with precedence deciding silently
 * which one ran. With a single root, "which document is this?" has one answer,
 * and a duplicate inside that root is an error rather than a race.
 */

import path from 'path';
import { fileURLToPath } from 'url';

/** How the catalog root was chosen, for diagnostics. */
export type CatalogRootSource = 'flag' | 'env' | 'config' | 'bundled';

/** The resolved catalog root and where the choice came from. */
export interface CatalogRoot {
  dir: string;
  source: CatalogRootSource;
}

/** The package's own `catalog/`, resolved the way the expressions dir is. */
function bundledCatalogDir(): string {
  // dist/catalog/roots.js -> ../../catalog
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../catalog');
}

/**
 * Resolves the catalog root: `--catalog` flag, then `IRON_MONKEY_CATALOG`,
 * then the config's `catalog.dir`, then the bundled corpus.
 *
 * @param opts - `flag` is the CLI value; `configured` is `catalog.dir`.
 */
export function resolveCatalogRoot(
  opts: { flag?: string; configured?: string } = {},
): CatalogRoot {
  if (opts.flag) return { dir: path.resolve(opts.flag), source: 'flag' };
  const env = process.env.IRON_MONKEY_CATALOG;
  if (env) return { dir: path.resolve(env), source: 'env' };
  if (opts.configured) return { dir: path.resolve(opts.configured), source: 'config' };
  return { dir: bundledCatalogDir(), source: 'bundled' };
}
