// The app's systemd user service and its daily backup (T069, slices 23b-2a and 23b-2b; design
// v1.8, Owner decisions 2026-10-13 and 2026-10-14): three units per project, written only by
// `factory deploy` from the fixed templates below: the app's service, the backup's service and
// its timer. The services name their release folder explicitly, never through a `current` link,
// and run factory code, `factory service app` or `factory service backup`, which start the run in
// the deploy sandbox; never pasta or bwrap directly. To switch, the deploy rewrites all three,
// reloads, restarts the app, then waits for it to answer HTTP on the laptop's loopback and for
// its unit to stay running with one main process, and only then restarts the timer; on any
// failure after the rewrite, each unit goes back as it was: its previous text, or, when there
// was none, stopped, disabled and removed. The previous release is read back from the app's unit
// itself, its only record.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { factoryRoot } from '../ci/sandbox.js';
import { RefusedError } from '../cli/env.js';
import { REPO } from '../model/config.js';
import { appPort, type AppFolder } from './sandbox.js';

/** A release folder's name: the commit, then the deploy time. */
export const RELEASE_NAME = /^[0-9a-f]{40}-\d{8}T\d{6}Z$/;

/** `owner/name`, with no `.` or `..` part, since it becomes a path. */
export const repoName = (repo: string) =>
  REPO.test(repo) && !repo.split('/').some((part) => part === '.' || part === '..');

/** `factory-<run>-<owner>--<name>.<type>`: an owner never holds two hyphens in a row. */
export const unitName = (
  repo: string,
  run: 'app' | 'backup' = 'app',
  type: 'service' | 'timer' = 'service',
) => `factory-${run}-${repo.replace('/', '--')}.${type}`;

/** Where units go: the Owner's `~/.config/systemd/user`, or the runtime folder in the tests. */
export interface UnitPlace {
  dir: string;
  /** Enabled with `--runtime`, so nothing lands in `~/.config`. */
  runtime: boolean;
}

export const userUnits = (home: string): UnitPlace => ({
  dir: join(home, '.config', 'systemd', 'user'),
  runtime: false,
});

/** The factory CLI as the unit runs it: the Node that ran the deploy, and this checkout's build. */
export const factoryProgram = () => [
  realpathSync(process.execPath),
  join(factoryRoot(), 'dist', 'cli', 'main.js'),
];

export interface AppService {
  repo: string;
  release: string;
  port: number;
  home: string;
  /** The checkout the program runs from, named in the unit's comment. */
  factory: string;
  program: readonly string[];
}

/** Characters a unit line can hold without quoting or systemd's `%` specifiers. */
const PLAIN = /^[A-Za-z0-9._/@+-]+$/;

/** The names a unit holds, checked; refuses anything a unit line would need to quote. */
function checked(s: AppService): void {
  const refuse = (what: string) =>
    new RefusedError(`${what}: refusing to write the unit for ${s.repo}`);
  if (!repoName(s.repo)) throw refuse(`${JSON.stringify(s.repo)} is not owner/name`);
  if (!RELEASE_NAME.test(s.release))
    throw refuse(`${JSON.stringify(s.release)} is not a release name`);
  for (const path of [s.home, s.factory, ...s.program])
    if (!PLAIN.test(path)) throw refuse(`${JSON.stringify(path)} needs quoting in a unit`);
}

const WRITTEN = '# Written by factory deploy (T069): do not edit; the next deploy rewrites it.';

/** The app unit's text: fixed here, with only names the factory checked. */
export function appUnit(s: AppService): string {
  checked(s);
  const port = String(appPort(s.port));
  return `${WRITTEN}
# Runs ${s.repo}'s app from release ${s.release} in the deploy sandbox, through the
# factory code in ${s.factory}: whatever dist/ was last built there is what
# runs at the service's next restart.
[Unit]
Description=factory: the app of ${s.repo}

[Service]
Type=simple
Environment=PATH=/usr/bin:/bin
Environment=HOME=${s.home}
ExecStart=${s.program.join(' ')} service app ${s.repo} ${s.release} --port ${port}
Restart=on-failure
RestartSec=5
IgnoreSIGPIPE=no
KillMode=control-group

[Install]
WantedBy=default.target
`;
}

/** The backup service's text: one run of the release's `npm run backup`, from its timer. */
export function backupUnit(s: AppService): string {
  checked(s);
  return `${WRITTEN}
# Backs up ${s.repo}'s data with release ${s.release} in the deploy sandbox, through the
# factory code in ${s.factory}: whatever dist/ was last built there is what
# runs at the next backup.
[Unit]
Description=factory: the daily backup of ${s.repo}

[Service]
Type=oneshot
Environment=PATH=/usr/bin:/bin
Environment=HOME=${s.home}
ExecStart=${s.program.join(' ')} service backup ${s.repo} ${s.release}
TimeoutStartSec=1h
IgnoreSIGPIPE=no
KillMode=control-group
`;
}

/** The backup timer's text: daily, and at the next start when the laptop was off. */
export function backupTimer(s: AppService): string {
  checked(s);
  return `${WRITTEN}
[Unit]
Description=factory: the daily backup of ${s.repo}

[Timer]
OnCalendar=daily
Persistent=true
Unit=${unitName(s.repo, 'backup')}

[Install]
WantedBy=timers.target
`;
}

/** The release a unit of these templates names for `repo`; undefined for anything else. */
export function unitRelease(
  text: string,
  repo: string,
  run: 'app' | 'backup' = 'app',
): string | undefined {
  const starts = text.split('\n').filter((line) => line.startsWith('ExecStart='));
  const escaped = repo.replace(/[.]/g, '\\.');
  const port = run === 'app' ? ' --port \\d+' : '';
  const match = new RegExp(
    `^ExecStart=\\S+(?: \\S+)* service ${run} ${escaped} (\\S+)${port}$`,
  ).exec(starts.length === 1 ? (starts[0] ?? '') : '');
  const release = match?.[1];
  return release !== undefined && RELEASE_NAME.test(release) ? release : undefined;
}

/** The app's settings file must be there, a regular file, never a link. */
export function checkSettings(app: AppFolder): void {
  const stat = lstatSync(app.settings, { throwIfNoEntry: false });
  if (stat === undefined)
    throw new RefusedError(
      `the app's settings file ${app.settings} is missing; create it, empty if the app needs no settings, with: install -D -m 600 /dev/null ${app.settings}`,
    );
  if (!stat.isFile())
    throw new RefusedError(`${app.settings} is not a regular file: the app's settings must be one`);
}

/** `systemctl --user`, with only what it needs to find the user manager; returns its output. */
function systemctl(env: NodeJS.ProcessEnv, args: readonly string[]): string {
  const outer = Object.fromEntries(
    ['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].flatMap((name) =>
      env[name] === undefined ? [] : [[name, env[name]]],
    ),
  );
  const run = spawnSync('systemctl', ['--user', ...args], { env: outer, encoding: 'utf8' });
  if (run.error !== undefined || run.status !== 0)
    throw new RefusedError(
      `systemctl --user ${args.join(' ')} failed: ${run.error?.message ?? run.stderr.trim()}`,
    );
  return run.stdout;
}

/** Refuses when there is no user manager to run the app. */
export function assertUserManager(env: NodeJS.ProcessEnv): void {
  try {
    systemctl(env, ['show', '--property=Version']);
  } catch (err) {
    throw new RefusedError(
      `factory deploy runs the app as a systemd user service, and ${(err as Error).message}; nothing was deployed`,
    );
  }
}

/** Writes a unit in place: a temporary file beside it, then a rename. */
function writeUnit(place: UnitPlace, name: string, text: string): void {
  mkdirSync(place.dir, { recursive: true });
  const temporary = join(place.dir, `.${name}.${String(process.pid)}.tmp`);
  writeFileSync(temporary, text, { mode: 0o644 });
  renameSync(temporary, join(place.dir, name));
}

const START_MS = 30_000;
const STEADY_MS = 10_000;

/** Whether anything accepts a connection on 127.0.0.1:<port> now. */
const listens = (port: number) =>
  new Promise<boolean>((ok) => {
    const socket = connect({ host: '127.0.0.1', port, timeout: 2000 });
    const done = (yes: boolean) => () => {
      socket.destroy();
      ok(yes);
    };
    socket.on('connect', done(true));
    socket.on('error', done(false));
    socket.on('timeout', done(false));
  });

/**
 * On a first deploy, refuses when something already listens on the app's port: pasta could not
 * bind it, and the start check would get its answer from the stranger.
 */
export async function assertPortFree(place: UnitPlace, repo: string, port: number) {
  if (existsSync(join(place.dir, unitName(repo))) || !(await listens(port))) return;
  throw new RefusedError(
    `something already listens on 127.0.0.1:${String(port)}, the app's port (app_port): stop it, or choose another with factory config set app_port <port>; nothing was deployed`,
  );
}

/**
 * Whether 127.0.0.1:<port> answers HTTP, any status, within `ms`. A TCP connection alone proves
 * nothing: pasta accepts on the laptop's side as soon as it listens, app or no app.
 */
async function answersHttp(port: number, ms: number): Promise<boolean> {
  const once = () =>
    new Promise<boolean>((ok) => {
      const req = request({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
        res.resume();
        ok(true);
      });
      req.on('error', () => {
        ok(false);
      });
      req.on('timeout', () => {
        req.destroy();
        ok(false);
      });
      req.end();
    });
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await once()) return true;
    await sleep(500);
  }
  return false;
}

/**
 * Whether the unit stays active with the same main process for `ms`. Type=simple counts as
 * active the moment it forks, so an answer alone could come from something else on the port
 * while the service, whose pasta cannot bind it, starts and fails over and over.
 */
async function steady(env: NodeJS.ProcessEnv, name: string, ms: number): Promise<boolean> {
  const state = () => {
    const out = systemctl(env, ['show', '--property=ActiveState', '--property=MainPID', name]);
    const pid = /^MainPID=(\d+)$/m.exec(out)?.[1] ?? '0';
    return /^ActiveState=active$/m.test(out) && pid !== '0' ? pid : undefined;
  };
  const first = state();
  if (first === undefined) return false;
  for (let waited = 0; waited < ms; waited += 1000) {
    await sleep(1000);
    if (state() !== first) return false;
  }
  return true;
}

/** A unit's text in `place`, or undefined when it is not there. */
export const readUnit = (place: UnitPlace, name: string) => {
  const path = join(place.dir, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
};

/**
 * Switches the app's unit and the backup's to `s.release` and restarts them; refuses, after
 * putting every unit back as it was, when any step after the rewrite fails or the app does not
 * answer and keep running. Returns the release it replaced, when the previous unit names one.
 */
export async function switchService(
  place: UnitPlace,
  s: AppService,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const name = unitName(s.repo);
  const backup = unitName(s.repo, 'backup');
  const timer = unitName(s.repo, 'backup', 'timer');
  const units: [string, string][] = [
    [name, appUnit(s)],
    [backup, backupUnit(s)],
    [timer, backupTimer(s)],
  ];
  const before = new Map(units.map(([unit]) => [unit, readUnit(place, unit)]));
  const app = before.get(name);
  const previous = app === undefined ? undefined : unitRelease(app, s.repo);
  const runtime = place.runtime ? ['--runtime'] : [];
  const port = `127.0.0.1:${String(s.port)}`;
  for (const [unit, text] of units) writeUnit(place, unit, text);
  let why: string;
  try {
    systemctl(env, ['daemon-reload']);
    systemctl(env, ['enable', ...runtime, name, timer]);
    systemctl(env, ['restart', name]);
    if (!(await answersHttp(s.port, START_MS)))
      why = `the new release ${s.release} did not answer HTTP on ${port} within 30 s`;
    else if (!(await steady(env, name, STEADY_MS)))
      why = `the service of the new release ${s.release} did not stay running with one main process for 10 s after ${port} answered; something else may be answering there`;
    else {
      systemctl(env, ['restart', timer]);
      return previous;
    }
  } catch (err) {
    why = (err as Error).message;
  }

  // Every step of the undo runs, even after one fails; the message names what failed.
  const failed: string[] = [];
  const step = (run: () => unknown) => {
    try {
      run();
    } catch (err) {
      failed.push((err as Error).message);
    }
  };
  const target = previous ?? 'its previous unit';
  const backupThere = [...before].some(([unit, text]) => unit !== name && text !== undefined);
  const [appGoal, appDone] =
    app !== undefined
      ? [`switch the service back to ${target}`, `switched the service back to ${target}`]
      : [
          "stop, disable and remove the service's first unit",
          'stopped and disabled the service, which had no earlier unit, and removed its unit',
        ];
  const [backupGoal, backupDone] = backupThere
    ? ["put the backup's units back as they were", "put the backup's units back as they were"]
    : ["remove the backup's units", "removed the backup's units"];
  // Units that were not there are stopped, the timer first, and disabled while systemd still
  // knows them; the backup's service has no [Install] section, so nothing enables it.
  for (const [unit] of [...units].reverse())
    if (before.get(unit) === undefined) {
      step(() => systemctl(env, ['stop', unit]));
      if (unit !== backup) step(() => systemctl(env, ['disable', ...runtime, unit]));
    }
  for (const [unit] of units)
    step(() => {
      const text = before.get(unit);
      if (text === undefined) rmSync(join(place.dir, unit), { force: true });
      else writeUnit(place, unit, text);
    });
  step(() => systemctl(env, ['daemon-reload']));
  for (const unit of [name, timer])
    if (before.get(unit) !== undefined) step(() => systemctl(env, ['restart', unit]));
  const undone =
    failed.length === 0
      ? `${appDone}, and ${backupDone}`
      : `tried to ${appGoal} and ${backupGoal}, but ${failed.join('; ')}`;
  throw new RefusedError(`${why}; ${undone}; nothing was deployed`);
}

/**
 * The backup's last result and time, from its service, so a failed backup is never unseen; or
 * that none has run yet.
 */
export function lastBackup(env: NodeJS.ProcessEnv, repo: string): string {
  const out = systemctl(env, [
    'show',
    '--property=Result,ExecMainExitTimestamp',
    unitName(repo, 'backup'),
  ]);
  const result = /^Result=(.*)$/m.exec(out)?.[1] ?? '';
  const at = /^ExecMainExitTimestamp=(.*)$/m.exec(out)?.[1] ?? '';
  if (at === '') return 'no backup has run yet';
  return result === 'success'
    ? `the last backup succeeded at ${at}`
    : `the last backup FAILED (${result}) at ${at}`;
}
