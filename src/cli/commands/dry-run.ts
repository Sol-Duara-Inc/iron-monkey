import { Command } from 'commander';
import { writeFile } from 'fs/promises';
import { addCommonFlags } from '../flags.js';
import { createCommandContext } from '../context.js';

export function dryRunCommand(): Command {
  const cmd = new Command('dry-run')
    .description('build the manifest, print it, exit')
    .argument('<workflow.yaml>', 'path to workflow YAML file');

  addCommonFlags(cmd);

  cmd.action(async (workflowPath: string, options: Record<string, unknown>) => {
    const { validateWorkflow } = await import('../../workflow/parser.js');
    const { resolveChainTree } = await import('../../workflow/chain-tree.js');
    const { resolveBusName } = await import('../../config/loader.js');
    const { loadExpressionRegistry } = await import('../../expressions/loader.js');
    const { buildManifest } = await import('../../manifest/builder.js');
    const { parseInjections } = await import('../../injection/parser.js');
    const { applyInjections } = await import('../../injection/apply.js');

    const { logger, config } = await createCommandContext(options);

    const workflow = await validateWorkflow(workflowPath);
    const registry = loadExpressionRegistry();
    const mainChain = resolveChainTree(workflow, registry);
    for (const d of mainChain.diagnostics ?? []) {
      logger.warn({ diagnostic: d }, 'resolution diagnostic (RFC §6.2)');
    }

    const injections = parseInjections((options.inject as string[]) ?? []);
    const busName = resolveBusName(config, options.bus as string | undefined);

    // Same builder options as the run path (emitter/runner.ts), so a dry-run
    // with the same seed/interval is a faithful preview of the run's plan —
    // interval reaches the planner as exact-interval mode, spawned chains
    // included (the old approach mutated main-chain timing fields only).
    const manifest = await buildManifest(
      { id: workflow.workflow.id, name: workflow.workflow.name },
      mainChain,
      config,
      {
        noConduit: true,
        seed: options.seed as number | undefined,
        busName,
        synth: options.synth !== false,
        interval: options.interval as number | undefined,
      },
    );

    const injected = applyInjections(manifest, injections);

    const output = JSON.stringify(injected, null, 2);

    if (options.manifestOut) {
      await writeFile(options.manifestOut as string, output, 'utf-8');
      logger.info({ path: options.manifestOut }, 'manifest written');
    }

    console.log(output);
  });

  return cmd;
}
