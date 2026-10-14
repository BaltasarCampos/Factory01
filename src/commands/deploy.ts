// `factory deploy` (contracts/cli.md, FR-007, T069; design v1.8, Owner decisions 2026-10-13):
// build and run main's verified commit on the laptop, only inside bubblewrap. Main's first-parent
// history is checked as `factory merge` checks it, in the Owner's checkout, which no sandbox ever
// sees (AC-073); the verified commit is exported without `.git` into a new release folder under
// the app folder; then `npm ci --ignore-scripts`, with the network, and the build, without, run
// in the deploy sandbox; then the app's systemd user unit is switched to the new release, and
// switched back if anything after the rewrite fails or the app does not answer and keep
// running (slice 23b-2a). The backup timer comes with 23b-2b; the signed `deployed` record, the
// summary and the health check with 23c. One deploy runs at a time.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { factoryRoot } from '../ci/sandbox.js';
import type { CommandContext } from '../cli/commands.js';
import { ExitCode } from '../cli/env.js';
import { buildRelease } from '../deploy/build.js';
import { withDeployLock } from '../deploy/lock.js';
import { newRelease } from '../deploy/release.js';
import { appFolder, deployRunner } from '../deploy/sandbox.js';
import {
  assertPortFree,
  assertUserManager,
  checkSettings,
  factoryProgram,
  switchService,
  userUnits,
} from '../deploy/service.js';
import { checkedMain } from '../merge/context.js';

export function deploy(ctx: CommandContext): Promise<number> {
  const home = ctx.env.HOME ?? homedir();
  return withDeployLock(home, async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'factory-deploy-'));
    try {
      const at = checkedMain(ctx.cwd, ctx.env, home, scratch);
      const app = appFolder(home, at.config.repo);
      // Everything the switch-over needs is checked before anything is exported.
      checkSettings(app);
      assertUserManager(ctx.env);
      const port = at.config.app_port;
      await assertPortFree(userUnits(home), at.config.repo, port);
      // Probed on an empty folder before anything is exported: without the sandbox, nothing is written.
      const probe = join(scratch, 'probe');
      mkdirSync(probe);
      deployRunner(app, probe, ctx.env);
      const release = newRelease(app, ctx.cwd, at.main, ctx.now(), ctx.env);
      ctx.io.stdout.write(`Exported main's verified ${at.main} to ${release}\n`);
      buildRelease(deployRunner(app, release, ctx.env), at.main, ctx.io.stdout);
      await switchService(
        userUnits(home),
        {
          ...{ repo: at.config.repo, release: basename(release), port, home },
          ...{ factory: factoryRoot(), program: factoryProgram() },
        },
        ctx.env,
      );
      ctx.io.stdout.write(
        `Switched the service to ${basename(release)}; it answered on 127.0.0.1:${String(port)}\n`,
      );
      return ExitCode.Ok;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
