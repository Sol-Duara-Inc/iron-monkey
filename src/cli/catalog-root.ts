/**
 * Resolves the catalog root for a command invocation: the `--catalog` flag,
 * then `IRON_MONKEY_CATALOG`, then the config's `catalog.dir`, then the
 * bundled corpus. Resolved once per command so every reference in one
 * invocation reads the same root.
 */
export async function catalogDirFor(
  options: Record<string, unknown>,
  configured?: string,
): Promise<string> {
  const { resolveCatalogRoot } = await import('../catalog/roots.js');
  return resolveCatalogRoot({ flag: options.catalog as string | undefined, configured }).dir;
}
