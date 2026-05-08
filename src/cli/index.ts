#!/usr/bin/env node
import { Command } from 'commander';
import { runCommand } from './commands/run.js';
import { validateCommand } from './commands/validate.js';
import { dryRunCommand } from './commands/dry-run.js';
import { inspectCommand } from './commands/inspect.js';
import { purgeCommand } from './commands/purge.js';
import { versionCommand } from './commands/version.js';

const program = new Command();

program
  .name('iron-monkey')
  .description('A CDEvents pitching machine for testing SDLC orchestration platforms')
  .addCommand(runCommand())
  .addCommand(validateCommand())
  .addCommand(dryRunCommand())
  .addCommand(inspectCommand())
  .addCommand(purgeCommand())
  .addCommand(versionCommand());

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
