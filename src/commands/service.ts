// `factory service app <owner>/<repo> <release> --port <port>` (contracts/cli.md, T069, slice
// 23b-2a): what the app's systemd user unit runs. It needs no terminal, but refuses in a cloud
// session. Only factory code wrote its arguments, and it checks them all again: the names, that
// the release is a real folder directly under the app's `releases/`, the port and the settings
// file. Then it runs the release's `npm start` in the deploy sandbox, with pasta's network and
// the port forwarded on the laptop's loopback, until the app exits; a non-zero exit is the
// service's, so the unit's Restart=on-failure starts it again.
import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { npmCli } from '../ci/sandbox.js';
import type { CommandContext } from '../cli/commands.js';
import { CLOUD_MARKER, ExitCode, RefusedError, UsageError } from '../cli/env.js';
import { appFolder, appPort, deployRunner } from '../deploy/sandbox.js';
import { checkSettings, RELEASE_NAME, repoName } from '../deploy/service.js';

export function service(ctx: CommandContext): Promise<number> {
  if (ctx.env[CLOUD_MARKER] !== undefined)
    throw new RefusedError(
      `factory service runs only on the Owner's laptop: ${CLOUD_MARKER} is set (cloud session)`,
    );
  const [run = '', repo = '', release = ''] = ctx.positionals;
  if (run !== 'app') throw new UsageError(`factory service runs app, not ${JSON.stringify(run)}`);
  if (!repoName(repo)) throw new RefusedError(`${JSON.stringify(repo)} is not owner/name`);
  if (!RELEASE_NAME.test(release))
    throw new RefusedError(`${JSON.stringify(release)} is not a release name (<sha>-<stamp>)`);
  const port = ctx.options.port;
  if (typeof port !== 'string' || !/^\d+$/.test(port))
    throw new RefusedError(`the app's port must be an integer from 1024 to 65535`);

  const app = appFolder(ctx.env.HOME ?? homedir(), repo);
  const folder = join(app.releases, release);
  const stat = lstatSync(folder, { throwIfNoEntry: false });
  if (stat?.isDirectory() !== true || realpathSync(folder) !== folder)
    throw new RefusedError(`${folder} is not a release folder: nothing was started`);
  checkSettings(app);

  const result = deployRunner(
    app,
    folder,
    ctx.env,
    appPort(Number(port)),
    true,
  )('app', [
    realpathSync(process.execPath),
    npmCli(),
    ...['start', '--no-update-notifier', '--logs-max=0'],
  ]);
  // Stopped by systemd: a clean stop, not a failure to restart from.
  const stopped = result.signal === 'SIGTERM' || result.signal === 'SIGINT';
  if (result.status === 0 || stopped) return Promise.resolve(ExitCode.Ok);
  ctx.io.stderr.write(
    `the app of ${repo} exited with ${String(result.status ?? result.signal ?? result.error?.message)}\n`,
  );
  return Promise.resolve(ExitCode.Refused);
}
