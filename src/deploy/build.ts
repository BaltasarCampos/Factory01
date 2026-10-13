// The product's build (T069; Owner decisions 2026-10-13): two sandboxed runs in the new release,
// `npm ci --ignore-scripts` with the network, then `npm run build` without, each with argv from
// factory code. The factory never runs npm, node or git on the app folder outside the sandbox, and
// the output it shows is only quoted, through visible().
import { realpathSync } from 'node:fs';
import type { Output } from '../cli/commands.js';
import { RefusedError } from '../cli/env.js';
import { npmCli } from '../ci/sandbox.js';
import { visible } from '../notify/summary.js';
import type { DeployRun, DeployRunner } from './sandbox.js';

const NOTHING = 'nothing was deployed';
const TAIL = 20;

/** Install and build `commit`'s release; refuses, naming the step, when either fails. */
export function buildRelease(run: DeployRunner, commit: string, out: Output): void {
  const npm = [realpathSync(process.execPath), npmCli()];
  const steps: [DeployRun, string, string[]][] = [
    ['install', 'npm ci --ignore-scripts', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']],
    ['build', 'npm run build', ['run', 'build', '--if-present']],
  ];
  for (const [step, name, args] of steps) {
    const result = run(step, [...npm, ...args, '--no-update-notifier']);
    if (result.error !== undefined || result.status !== 0) {
      const said = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-TAIL);
      throw new RefusedError(
        `the build of ${commit} failed at ${name}; ${NOTHING}:\n  ${[
          ...(result.error === undefined ? [] : [result.error.message]),
          ...said.map(visible),
        ].join('\n  ')}`,
      );
    }
    out.write(`${name}: done in the sandbox\n`);
  }
}
