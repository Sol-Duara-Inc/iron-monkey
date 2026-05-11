import { Command } from 'commander';
import { writeFile } from 'fs/promises';
import { addCommonFlags } from '../flags.js';

export function dryRunCommand(): Command {
  const cmd = new Command('dry-run')
    .description('build the manifest, print it, exit')
    .argument('<workflow.yaml>', 'path to workflow YAML file');

  addCommonFlags(cmd);

  cmd.action(async (workflowPath: string, options: Record<string, unknown>) => {
    const { validateWorkflow, resolveProduces } = await import('../../workflow/parser.js');
    const { loadConfig, resolveBusName } = await import('../../loaders/config.loader.js');
    const { loadExpressionRegistry } = await import('../../loaders/expression.loader.js');
    const { buildManifest } = await import('../../manifest/builder.js');
    const { parseInjections } = await import('../../injection/parser.js');
    const { applyInjections } = await import('../../injection/apply.js');
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
    const registry = loadExpressionRegistry();
    const events = resolveProduces(workflow, registry);

    const interval = options.interval as number | undefined;
    if (typeof interval === 'number' && interval >= 0) {
      for (const e of events) {
        e.min_wait_ms = interval;
        e.timeout_ms = interval;
      }
    }

    const injections = parseInjections((options.inject as string[]) ?? []);
    const busName = resolveBusName(config, options.bus as string | undefined);

    const manifest = await buildManifest(
      { id: workflow.workflow.id, name: workflow.workflow.name },
      events,
      config,
      {
        noConduit: true,
        seed: options.seed as number | undefined,
        busName,
        synth: options.synth !== false,
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
