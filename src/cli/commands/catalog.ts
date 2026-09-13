import { Command } from 'commander';

/**
 * `iron-monkey catalog` — see what can be pitched by name.
 *
 * A catalog you cannot enumerate is a catalog you cannot choose from, so
 * `list` is not a convenience: it is the other half of naming an entry.
 * `verify` is the gate — it reports the problems the loader deliberately
 * defers, so a broken file is found before a run needs it rather than during.
 */
export function catalogCommand(): Command {
  const cmd = new Command('catalog').description('inspect the workflow and expression catalog');

  const withRoot = (c: Command): Command =>
    c.option('--catalog <dir>', 'catalog directory (default: IRON_MONKEY_CATALOG, then bundled)');

  withRoot(
    cmd
      .command('list')
      .description('list every catalog entry')
      .option('--json', 'machine-readable output')
      .action(async (options: Record<string, unknown>) => {
        const { catalog, dir } = await open(options);
        const entries = catalog.list();
        if (options.json === true) {
          process.stdout.write(JSON.stringify({ dir, entries }, null, 2) + '\n');
          return;
        }
        process.stdout.write(`${dir}\n`);
        for (const kind of ['workflow', 'expression'] as const) {
          const of = entries.filter((e) => e.kind === kind);
          if (of.length === 0) continue;
          process.stdout.write(`\n${kind}s (${of.length})\n`);
          for (const e of of) process.stdout.write(`  catalog:${e.id}\n`);
        }
        const bad = catalog.problems().length + catalog.conflicts().length;
        if (bad > 0) {
          process.stdout.write(`\n${bad} problem(s) — run 'iron-monkey catalog verify'\n`);
        }
      }),
  );

  withRoot(
    cmd
      .command('show')
      .description('print the file backing a catalog reference')
      .argument('<ref>', 'catalog:<workflow-id> or catalog:<group>/<author>/<expression>')
      .action(async (ref: string, options: Record<string, unknown>) => {
        const { parseCatalogRef, isCatalogRef, CATALOG_SCHEME } =
          await import('../../catalog/ref.js');
        // Accept a bare id too: here the argument is unambiguously a reference,
        // because `show` takes nothing else.
        const token = isCatalogRef(ref) ? ref : `${CATALOG_SCHEME}${ref}`;
        const parsed = parseCatalogRef(token);
        const { catalog } = await open(options);
        process.stdout.write(catalog.resolve(parsed.kind, parsed.id) + '\n');
      }),
  );

  withRoot(
    cmd
      .command('verify')
      .description('report unreadable entries and identities claimed by more than one file')
      .action(async (options: Record<string, unknown>) => {
        const { catalog, dir } = await open(options);
        const problems = catalog.problems();
        const conflicts = catalog.conflicts();
        process.stdout.write(`${dir}: ${catalog.list().length} entries\n`);
        for (const p of problems) process.stdout.write(`  UNREADABLE ${p.file}: ${p.message}\n`);
        for (const c of conflicts) {
          process.stdout.write(`  AMBIGUOUS  ${c.id}: ${c.files.join(', ')}\n`);
        }
        const misnamed = catalog.list().filter((e) => e.misnamed);
        for (const m of misnamed) {
          process.stdout.write(`  MISNAMED   ${m.file} declares '${m.id}'\n`);
        }
        if (problems.length + conflicts.length === 0) {
          process.stdout.write(misnamed.length === 0 ? '  ok\n' : '  ok (with misnamed files)\n');
        } else {
          process.exitCode = 1;
        }
      }),
  );

  return cmd;
}

async function open(options: Record<string, unknown>) {
  const { resolveCatalogRoot } = await import('../../catalog/roots.js');
  const { loadCatalog } = await import('../../catalog/store.js');
  const { createLogger, setLogger } = await import('../../logger/index.js');
  setLogger(createLogger({ level: 'warn', format: 'text' }));
  const root = resolveCatalogRoot({ flag: options.catalog as string | undefined });
  return { catalog: loadCatalog(root.dir), dir: root.dir };
}
