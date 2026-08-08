import { Command } from 'commander';
import { createCommandContext } from '../context.js';

export function inspectCommand(): Command {
  return new Command('inspect')
    .description('show queue/topic depth and bindings')
    .argument('<bus-name>', 'bus name from config')
    .option('--config <path>', 'path to JSON/YAML config file')
    .option('--log-level <level>', 'error | warn | info | debug', 'info')
    .option('--log-format <fmt>', 'json | text', 'json')
    .action(async (busName: string, options: Record<string, unknown>) => {
      const { createBus } = await import('../../bus/interface.js');

      const { config } = await createCommandContext(options);
      const busConfig = config.buses[busName];
      if (!busConfig) {
        console.error(`Bus '${busName}' not found in config`);
        process.exit(1);
      }

      const bus = await createBus(busName, busConfig);
      await bus.connect();
      const info = await bus.inspect();
      await bus.disconnect();

      console.log(JSON.stringify(info, null, 2));
    });
}
