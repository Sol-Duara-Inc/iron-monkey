import { Command } from 'commander';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

export function versionCommand(): Command {
  return new Command('version').description('print version and exit').action(async () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const root = path.resolve(__dirname, '../../..');

    // Prefer VERSION file when present; fall back to package.json
    let version: string;
    try {
      version = (await readFile(path.join(root, 'VERSION'), 'utf-8')).trim();
    } catch {
      const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf-8')) as {
        version: string;
      };
      version = pkg.version;
    }

    console.log(`iron-monkey ${version}`);
  });
}
