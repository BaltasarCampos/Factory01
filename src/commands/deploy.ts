// `factory deploy` (contracts/cli.md, FR-007, T069; design v1.8, Owner decisions 2026-10-13):
// build and run main's verified commit on the laptop, only inside bubblewrap. Main's first-parent
// history is checked as `factory merge` checks it, in the Owner's checkout, which no sandbox ever
// sees (AC-073); the verified commit is exported without `.git` into a new release folder under
// the app folder; then `npm ci --ignore-scripts`, with the network, and the build, without, run
// in the deploy sandbox; then the app's systemd user unit is switched to the new release, and
// switched back if anything after the rewrite fails or the app does not answer and keep
// running (slice 23b-2a); the backup's service and timer are switched with it, old releases
// are removed, and the backup's last result is printed (slice 23b-2b). Before the export, after
// the local checks: the pause warning, and the chain of every item merged since the last deploy
// re-verified (slice 23c-1a); a successful deploy is appended to `deploys.log`. The summary and
// the signed `deployed` record come with 23c-1b, the health check with 23c-2. One deploy runs at
// a time.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { factoryRoot } from '../ci/sandbox.js';
import type { CommandContext } from '../cli/commands.js';
import { ExitCode } from '../cli/env.js';
import { buildRelease } from '../deploy/build.js';
import { cleanReleases } from '../deploy/cleanup.js';
import { appendDeploy, deploysLogPath, lastDeploy } from '../deploy/deploys-log.js';
import { withDeployLock } from '../deploy/lock.js';
import { newRelease } from '../deploy/release.js';
import { appFolder, deployRunner } from '../deploy/sandbox.js';
import {
  assertPortFree,
  assertUserManager,
  checkSettings,
  factoryProgram,
  lastBackup,
  switchService,
  userUnits,
} from '../deploy/service.js';
import { shippedSince, verifyShipped } from '../deploy/shipped.js';
import { checkedMain } from '../merge/context.js';
import { confirmPause } from '../pause/confirm.js';

const NOTHING = 'nothing was deployed';

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
      await confirmPause(ctx, at, 'Deploy anyway while paused?', NOTHING);
      const log = deploysLogPath(home, at.config.repo);
      const shipped = shippedSince(at, lastDeploy(log)?.main);
      await verifyShipped(at, shipped);
      const since =
        shipped.since === undefined
          ? 'the baseline'
          : `the last deploy (${shipped.since.slice(0, 12)})`;
      const items = shipped.items.map((i) => `#${String(i.issue)}`);
      ctx.io.stdout.write(
        `Since ${since}: ${String(shipped.commits.length)} commit(s); ${items.length === 0 ? 'no items merged' : `re-verified the approvals of ${items.join(', ')}`}\n`,
      );
      const release = newRelease(app, ctx.cwd, at.main, ctx.now(), ctx.env);
      ctx.io.stdout.write(`Exported main's verified ${at.main} to ${release}\n`);
      buildRelease(deployRunner(app, release, ctx.env), at.main, ctx.io.stdout);
      const units = userUnits(home);
      const previous = await switchService(
        units,
        {
          ...{ repo: at.config.repo, release: basename(release), port, home },
          ...{ factory: factoryRoot(), program: factoryProgram() },
        },
        ctx.env,
      );
      ctx.io.stdout.write(
        `Switched the service to ${basename(release)}; it answered on 127.0.0.1:${String(port)}\n`,
      );
      const cleanup = cleanReleases(app, units, at.config.repo, previous);
      if (cleanup.removed.length > 0)
        ctx.io.stdout.write(`Removed old releases: ${cleanup.removed.join(', ')}\n`);
      for (const line of cleanup.failed) ctx.io.stderr.write(`warning: ${line}\n`);
      let backup: string;
      try {
        backup = lastBackup(ctx.env, at.config.repo);
      } catch (err) {
        backup = `could not be read: ${(err as Error).message}`;
      }
      ctx.io.stdout.write(`Backup: ${backup}\n`);
      appendDeploy(log, { at: ctx.now().toISOString(), main: at.main, release: basename(release) });
      return ExitCode.Ok;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
