import { Command } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Iron Monkey's own version: the VERSION file when present, else package.json.
 * Synchronous because `--version` needs the string while the program is being
 * defined, before anything is parsed.
 */
export function readVersion(root: string = ROOT): string {
  try {
    return readFileSync(path.join(root, 'VERSION'), 'utf-8').trim();
  } catch {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
      version: string;
    };
    return pkg.version;
  }
}

/** What both `iron-monkey version` and `iron-monkey --version` print. */
export function versionLine(): string {
  return `iron-monkey ${readVersion()}`;
}

export function versionCommand(): Command {
  return new Command('version').description('print version and exit').action(() => {
    console.log(versionLine());
  });
}
