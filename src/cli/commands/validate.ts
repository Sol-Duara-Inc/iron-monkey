import { Command } from 'commander';
import { addCommonFlags } from '../flags.js';

export function validateCommand(): Command {
  const cmd = new Command('validate')
    .description('parse and validate workflow and planned events; do not connect to bus')
    .argument('<workflow.yaml>', 'path to workflow YAML file');

  addCommonFlags(cmd);

  cmd.action(async (workflowPath: string, options: Record<string, unknown>) => {
    const { validateWorkflow } = await import('../../workflow/parser.js');
    const { resolveChainTree } = await import('../../workflow/chain-tree.js');
    const { loadConfig, resolveBusName } = await import('../../config/loader.js');
    const { loadExpressionRegistry } = await import('../../expressions/loader.js');
    const { buildManifest } = await import('../../manifest/builder.js');
    const { createLogger, setLogger } = await import('../../logger/index.js');

    const logger = createLogger({
      level: options.logLevel as 'info',
      format: options.logFormat as 'json',
    });
    setLogger(logger);

    const config = await loadConfig({
      configPath: options.config as string | undefined,
      cliOverrides: { busName: options.bus as string | undefined },
    });

    const workflow = await validateWorkflow(workflowPath);
    logger.info({ workflowId: workflow.workflow.id }, 'workflow is valid');

    const registry = loadExpressionRegistry();
    const mainChain = resolveChainTree(workflow, registry);
    const busName = resolveBusName(config, options.bus as string | undefined);

    const manifest = await buildManifest(
      { id: workflow.workflow.id, name: workflow.workflow.name },
      mainChain,
      config,
      { noConduit: true, seed: options.seed as number | undefined, busName },
    );

    const detachedEventCount = (manifest.detachedChains ?? []).reduce(
      (n, c) => n + c.events.length,
      0,
    );
    logger.info(
      {
        eventCount: manifest.events.length,
        detachedChainCount: manifest.detachedChains?.length ?? 0,
        detachedEventCount,
      },
      'manifest built and validated successfully',
    );
    console.log('✓ Workflow and all planned events are valid');
  });

  return cmd;
}
