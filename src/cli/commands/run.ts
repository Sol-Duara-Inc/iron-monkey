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
    const { serveInquiriesUntilIdle } = await import('../inquiry.js');

    // Start BEFORE the run, not after: an inquiry can arrive while the
    // pipeline is still going (a TTL early in a long workflow expires before
    // the run ends), and the record answers live because the store holds the
    // manifest by reference.
    const inquiry = await serveInquiriesUntilIdle(_options);

    if (_workflowPaths.length === 1) {
      await runWorkflow(new FileWorkflowSource(_workflowPaths[0]), _options);
    } else {
      const results = await runWorkflows(
        _workflowPaths.map((p) => new FileWorkflowSource(p)),
        _options,
      );
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        for (const r of failed) {
          process.stderr.write(`[FAILED] ${r.workflowPath}: ${r.error}\n`);
        }
        process.exitCode = 1;
      }
    }

    // Runs are done; hold the process open only as long as the endpoint wants
    // to keep answering. Without --serve this resolves immediately and the
    // CLI exits exactly as before.
    await inquiry.untilIdle();
  });

  return cmd;
}
