// `factory deploy` (contracts/cli.md, FR-007, T069; design v1.8, Owner decisions 2026-10-13):
// build and run main's verified commit on the laptop, only inside bubblewrap. Main's first-parent
// history is checked as `factory merge` checks it, in the Owner's checkout, which no sandbox ever
// sees (AC-073); the verified commit is exported without `.git` into a new release folder under
// the app folder; then `npm ci --ignore-scripts`, with the network, and the build, without, run
// in the deploy sandbox. The switch-over and the systemd units come with slice 23b; the signed
// `deployed` record, the summary and the health check with 23c.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from '../cli/commands.js';
import { RefusedError } from '../cli/env.js';
import { buildRelease } from '../deploy/build.js';
import { newRelease } from '../deploy/release.js';
import { appFolder, deployRunner } from '../deploy/sandbox.js';
import { checkedMain } from '../merge/context.js';

export function deploy(ctx: CommandContext): Promise<number> {
  const home = ctx.env.HOME ?? homedir();
  const scratch = mkdtempSync(join(tmpdir(), 'factory-deploy-'));
  try {
    const at = checkedMain(ctx.cwd, ctx.env, home, scratch);
    const app = appFolder(home, at.config.repo);
    // Probed on an empty folder before anything is exported: without the sandbox, nothing is written.
    const probe = join(scratch, 'probe');
    mkdirSync(probe);
    deployRunner(app, probe, ctx.env);
    const release = newRelease(app, ctx.cwd, at.main, ctx.now(), ctx.env);
    ctx.io.stdout.write(`Exported main's verified ${at.main} to ${release}\n`);
    buildRelease(deployRunner(app, release, ctx.env), at.main, ctx.io.stdout);
    throw new RefusedError(
      `built ${at.main} at ${release}; switching the service comes with slice 23b; nothing was deployed`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
