// `factory service app <owner>/<repo> <release> --port <port>` and `factory service backup
// <owner>/<repo> <release>` (contracts/cli.md, T069, slices 23b-2a and 23b-2b): what the app's
// and the backup's systemd user units run. They need no terminal, but refuse in a cloud session.
// Only factory code wrote their arguments, and they check them all again: the names, that the
// release is a real folder directly under the app's `releases/`, the app's port and settings
// file. The app runs the release's `npm start` in the deploy sandbox, with pasta's network and
// the port forwarded on the laptop's loopback, until it exits; a non-zero exit is the service's,
// so the unit's Restart=on-failure starts it again. The backup runs the release's `npm run
// backup` once, without network or settings; a non-zero exit fails its unit, which the next
// deploy reports.
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
  if (run !== 'app' && run !== 'backup')
    throw new UsageError(`factory service runs app or backup, not ${JSON.stringify(run)}`);
  if (!repoName(repo)) throw new RefusedError(`${JSON.stringify(repo)} is not owner/name`);
  if (!RELEASE_NAME.test(release))
    throw new RefusedError(`${JSON.stringify(release)} is not a release name (<sha>-<stamp>)`);
  const port = ctx.options.port;
  if (run === 'backup' && port !== undefined)
    throw new UsageError('factory service backup takes no port: the backup has no network');
  if (run === 'app' && (typeof port !== 'string' || !/^\d+$/.test(port)))
    throw new RefusedError(`the app's port must be an integer from 1024 to 65535`);

  const app = appFolder(ctx.env.HOME ?? homedir(), repo);
  const folder = join(app.releases, release);
  const stat = lstatSync(folder, { throwIfNoEntry: false });
  if (stat?.isDirectory() !== true || realpathSync(folder) !== folder)
    throw new RefusedError(`${folder} is not a release folder: nothing was started`);
  const node = realpathSync(process.execPath);
  const npm = ['--no-update-notifier', '--logs-max=0'];

  if (run === 'backup') {
    const result = deployRunner(
      app,
      folder,
      ctx.env,
      undefined,
      true,
    )('backup', [...[node, npmCli(), 'run', 'backup', ...npm]]);
    if (result.status === 0) return Promise.resolve(ExitCode.Ok);
    ctx.io.stderr.write(
      `the backup of ${repo} exited with ${String(result.status ?? result.signal ?? result.error?.message)}\n`,
    );
    return Promise.resolve(ExitCode.Refused);
  }
  checkSettings(app);
  const result = deployRunner(
    app,
    folder,
    ctx.env,
    appPort(Number(port)),
    true,
  )('app', [node, npmCli(), 'start', ...npm]);
  // Stopped by systemd: a clean stop, not a failure to restart from.
  const stopped = result.signal === 'SIGTERM' || result.signal === 'SIGINT';
  if (result.status === 0 || stopped) return Promise.resolve(ExitCode.Ok);
  ctx.io.stderr.write(
    `the app of ${repo} exited with ${String(result.status ?? result.signal ?? result.error?.message)}\n`,
  );
  return Promise.resolve(ExitCode.Refused);
}
