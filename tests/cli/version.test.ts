/**
 * `iron-monkey --version`, `-V` and `iron-monkey version` — driven through
 * the real root program via commander (no child processes), and checked
 * against the VERSION file rather than a literal, so a release bump never has
 * to touch this test and a desync between the two outputs cannot pass.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { CommanderError } from 'commander';
import { createProgram } from '../../src/cli/program.js';
import { readVersion } from '../../src/cli/commands/version.js';
import { makeTmpDir } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED = `iron-monkey ${readFileSync(path.resolve(__dirname, '../../VERSION'), 'utf-8').trim()}`;

/** Parses `args` with the real program; returns what it wrote and how it exited. */
function run(args: string[]): { out: string; error: CommanderError | undefined } {
  let out = '';
  const program = createProgram()
    .exitOverride()
    .configureOutput({ writeOut: (s) => (out += s), writeErr: (s) => (out += s) });
  try {
    program.parse(['node', 'iron-monkey', ...args]);
    return { out, error: undefined };
  } catch (err) {
    if (err instanceof CommanderError) return { out, error: err };
    throw err;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the version flags', () => {
  it.each(['--version', '-V'])('%s prints the version line and exits 0', (flag) => {
    const { out, error } = run([flag]);
    // Before the flag was wired this was commander.unknownOption, exit 1.
    expect(error?.code).toBe('commander.version');
    expect(error?.exitCode).toBe(0);
    expect(out.trim()).toBe(EXPECTED);
  });

  it('prints exactly what the `version` subcommand prints', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { error } = run(['version']);
    expect(error).toBeUndefined();
    expect(log).toHaveBeenCalledWith(EXPECTED);
    expect(run(['--version']).out.trim()).toBe(log.mock.calls[0][0]);
  });

  it('lists --version in the root help', () => {
    const { out } = run(['--help']);
    expect(out).toMatch(/-V, --version\s+print version and exit/);
  });
});

describe('readVersion', () => {
  it('prefers the VERSION file over package.json', async () => {
    const dir = await makeTmpDir('im-version');
    await writeFile(path.join(dir, 'VERSION'), '7.7.7\n');
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: '1.1.1' }));
    expect(readVersion(dir)).toBe('7.7.7');
  });

  it('falls back to package.json when there is no VERSION file', async () => {
    const dir = await makeTmpDir('im-version');
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: '1.1.1' }));
    expect(readVersion(dir)).toBe('1.1.1');
  });
});
