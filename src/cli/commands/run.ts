import { Command } from 'commander';
import { addCommonFlags } from '../flags.js';

export function runCommand(): Command {
  const cmd = new Command('run')
    .description('emit events per the workflow(s); pass multiple paths to run them simultaneously')
    .argument('<workflows...>', 'one or more paths to workflow YAML files');

  addCommonFlags(cmd);

  cmd.action(async (_workflowPaths: string[], _options: Record<string, unknown>) => {
    const { runWorkflow, runWorkflows } = await import('../../emitter/runner.js');
    const { FileWorkflowSource } = await import('../../workflow/source.js');
    if (_workflowPaths.length === 1) {
      await runWorkflow(new FileWorkflowSource(_workflowPaths[0]), _options);
    } else {
      const results = await runWorkflows(_workflowPaths.map((p) => new FileWorkflowSource(p)), _options);
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        for (const r of failed) {
          process.stderr.write(`[FAILED] ${r.workflowPath}: ${r.error}\n`);
        }
        process.exitCode = 1;
      }
    }
  });

  return cmd;
}
