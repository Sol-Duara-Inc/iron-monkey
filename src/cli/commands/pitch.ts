import { Command } from 'commander';

export function pitchCommand(): Command {
  return new Command('pitch')
    .description('pitch all workflows in a repertoire YAML simultaneously')
    .requiredOption('--from <repertoire.yaml>', 'path to repertoire YAML file')
    .option('--config <path>', 'path to Iron Monkey config file')
    .option('--log-level <level>', 'error | warn | info | debug', 'info')
    .option('--log-format <fmt>', 'json | text', 'json')
    .action(async (options: Record<string, unknown>) => {
      const { loadRepertoire, buildPitchOptions } = await import('../../repertoire/loader.js');
      const { runWorkflow } = await import('../../emitter/runner.js');

      const repertoire = await loadRepertoire(options.from as string);
      const pitches = buildPitchOptions(repertoire, {
        config: options.config as string | undefined,
        logLevel: options.logLevel as string | undefined,
        logFormat: options.logFormat as string | undefined,
      });

      const settlements = await Promise.allSettled(
        pitches.map(({ workflowPath, options: runOpts }) => runWorkflow(workflowPath, runOpts)),
      );

      const failed = settlements.filter((s) => s.status === 'rejected');
      if (failed.length > 0) {
        settlements.forEach((s, i) => {
          if (s.status === 'rejected') {
            process.stderr.write(
              `[FAILED] ${pitches[i].workflowPath}: ${(s.reason as Error)?.message ?? s.reason}\n`,
            );
          }
        });
        process.exitCode = 1;
      }
    });
}
