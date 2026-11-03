import { Command } from 'commander';
import { runCommand } from './commands/run.js';
import { pitchCommand } from './commands/pitch.js';
import { validateCommand } from './commands/validate.js';
import { dryRunCommand } from './commands/dry-run.js';
import { inspectCommand } from './commands/inspect.js';
import { purgeCommand } from './commands/purge.js';
import { serveCommand } from './commands/serve.js';
import { catalogCommand } from './commands/catalog.js';
import { versionCommand, versionLine } from './commands/version.js';

/**
 * The root program, built without parsing anything — so a test can drive the
 * real flags through commander instead of re-declaring them.
 */
export function createProgram(): Command {
  return (
    new Command()
      .name('iron-monkey')
      .description('A CDEvents pitching machine for testing SDLC orchestration platforms')
      // Same line as the `version` subcommand, so the two cannot disagree.
      .version(versionLine(), '-V, --version', 'print version and exit')
      .addCommand(runCommand())
      .addCommand(pitchCommand())
      .addCommand(validateCommand())
      .addCommand(dryRunCommand())
      .addCommand(inspectCommand())
      .addCommand(purgeCommand())
      .addCommand(catalogCommand())
      .addCommand(serveCommand())
      .addCommand(versionCommand())
  );
}
