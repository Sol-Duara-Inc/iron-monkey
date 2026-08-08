import { Command } from 'commander';
import { createCommandContext } from '../context.js';

export function purgeCommand(): Command {
  return new Command('purge')
    .description('drain a queue / reset a topic (requires --confirm)')
    .argument('<bus-name>', 'bus name from config')
    .option('--config <path>', 'path to JSON/YAML config file')
    .option('--confirm', 'required to execute purge')
    .option('--queue <name>', 'specific queue name (RabbitMQ)')
    .option('--group <name>', 'consumer group to reset (Kafka)')
    .option('--log-level <level>', 'error | warn | info | debug', 'info')
    .option('--log-format <fmt>', 'json | text', 'json')
    .action(async (busName: string, options: Record<string, unknown>) => {
      if (!options.confirm) {
        console.error('--confirm is required to execute purge');
        process.exit(1);
      }

      const { createBus } = await import('../../bus/interface.js');

      const { logger, config } = await createCommandContext(options);
      const busConfig = config.buses[busName];
      if (!busConfig) {
        console.error(`Bus '${busName}' not found in config`);
        process.exit(1);
      }

      const bus = await createBus(busName, busConfig);
      await bus.connect();
      await bus.purge({
        queue: options.queue as string | undefined,
        group: options.group as string | undefined,
      });
      await bus.disconnect();

      logger.info({ bus: busName }, 'purge complete');
    });
}
