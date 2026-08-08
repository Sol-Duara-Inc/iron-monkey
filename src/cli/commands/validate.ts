import { Command } from 'commander';
import { addCommonFlags } from '../flags.js';
import { createCommandContext } from '../context.js';

export function validateCommand(): Command {
  const cmd = new Command('validate')
    .description('parse and validate workflow and planned events; do not connect to bus')
    .argument('<workflow.yaml>', 'path to workflow YAML file');

  addCommonFlags(cmd);

  cmd.action(async (workflowPath: string, options: Record<string, unknown>) => {
    const { validateWorkflow } = await import('../../workflow/parser.js');
    const { resolveChainTree } = await import('../../workflow/chain-tree.js');
    const { resolveBusName } = await import('../../config/loader.js');
    const { loadExpressionRegistry } = await import('../../expressions/loader.js');
    const { buildManifest } = await import('../../manifest/builder.js');

    const { logger, config } = await createCommandContext(options);

    const workflow = await validateWorkflow(workflowPath);
    logger.info({ workflowId: workflow.workflow.id }, 'workflow is valid');

    const registry = loadExpressionRegistry();

    // Name-hint enforcement (RFC §4.1.1). `validate` is the publication gate:
    // violations are hard errors here, while plain runs only skip-with-warning.
    // Diagnostics are advisory and never fail validation.
    const findings = registry.hintFindings();
    for (const finding of findings) {
      for (const d of finding.result.diagnostics) {
        logger.warn({ identity: finding.identity, file: finding.file }, `name-hint: ${d.message}`);
      }
    }
    const violating = findings.filter((f) => f.skipped);
    if (violating.length > 0) {
      for (const f of violating) {
        for (const v of f.result.violations) {
          console.error(`✗ ${f.identity}: ${v.message}`);
        }
      }
      throw new Error(
        `${violating.length} expression(s) in the store have unsatisfied name hints (RFC §4.1.1)`,
      );
    }

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
