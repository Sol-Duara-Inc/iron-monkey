import { Command } from 'commander';
import { addCommonFlags } from '../flags.js';

export function runCommand(): Command {
  const cmd = new Command('run')
    .description('emit events per the workflow')
    .argument('<workflow.yaml>', 'path to workflow YAML file');

  addCommonFlags(cmd);

  cmd.action(async (_workflowPath: string, _options: Record<string, unknown>) => {
    const { runWorkflow } = await import('../../emitter/runner.js');
    await runWorkflow(_workflowPath, _options);
  });

  return cmd;
}
