import { Command } from 'commander';

export function addCommonFlags(cmd: Command): Command {
  return cmd
    .option('--config <path>', 'path to JSON/YAML config file')
    .option('--bus <name>', 'bus name to use (overrides IRON_MONKEY_BUS_NAME env var)')
    .option('--no-conduit', 'skip chainId acquisition; use fallback URN')
    .option(
      '--no-synth',
      'disable simulated-data synthesis; fail validation on missing required fields',
    )
    .option(
      '--interval <ms>',
      'exact per-event emission interval, spawned chains included (blocking waits still apply)',
      parseInt,
    )
    .option('--seed <int>', 'seed for deterministic IDs and timing', parseInt)
    .option('--inject <spec>', 'failure injection spec (repeatable)', collect, [])
    .option('--manifest-out <path>', 'write pre-allocated manifest to file (JSON)')
    .option('--log-level <level>', 'error | warn | info | debug', 'info')
    .option('--log-format <fmt>', 'json | text', 'json');
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
