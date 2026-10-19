// Global setup for every Vitest project: put the test doubles (fake `gh`) first on PATH so
// no test can reach the real GitHub CLI, and give the event loop a turn after every test.
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

const binDir = join(fileURLToPath(new URL('.', import.meta.url)), 'bin');

if (!(process.env.PATH ?? '').split(delimiter).includes(binDir)) {
  process.env.PATH = [binDir, process.env.PATH ?? ''].join(delimiter);
}

// Cloud marker must never leak in from the developer's shell; tests set it explicitly.
delete process.env.CLAUDE_CODE_REMOTE;

// Between tests, let the event loop take one turn. The runner moves from test to test on
// promises alone, so in a file whose tests block on child processes (spawnSync) the worker never
// reads Vitest's RPC replies until the file ends, and past 60 s the pending call times out
// ("Timeout calling onTaskUpdate"), failing the run with every test green.
afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});
