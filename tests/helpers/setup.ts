// Global setup for every Vitest project: put the test doubles (fake `gh`) first on PATH so
// no test can reach the real GitHub CLI.
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const binDir = join(fileURLToPath(new URL('.', import.meta.url)), 'bin');

if (!(process.env.PATH ?? '').split(delimiter).includes(binDir)) {
  process.env.PATH = [binDir, process.env.PATH ?? ''].join(delimiter);
}

// Cloud marker must never leak in from the developer's shell; tests set it explicitly.
delete process.env.CLAUDE_CODE_REMOTE;
