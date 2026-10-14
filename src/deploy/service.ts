// The app's systemd user service (T069, slice 23b-2a; design v1.8, Owner decisions 2026-10-13):
// one unit per project, written only by `factory deploy` from the fixed template below. The unit
// names its release folder explicitly, never through a `current` link, and runs factory code,
// `factory service app`, which starts the app in the deploy sandbox through the attach helper
// and pasta; never pasta or bwrap directly. To switch, the deploy rewrites the unit, reloads and
// restarts it, then waits for the app to answer HTTP on the laptop's loopback and for the unit to
// stay running with one main process; on any failure after the unit is rewritten, the previous
// unit's text goes back, or, on a first deploy, the service is stopped, disabled and removed.
// The previous release is read back from the unit itself, its only record.
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

/** `factory-app-<owner>--<name>.service`: an owner never holds two hyphens in a row. */
export const unitName = (repo: string) => `factory-app-${repo.replace('/', '--')}.service`;

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

/** The unit's text: fixed here, with only names the factory checked. */
export function appUnit(s: AppService): string {
  const refuse = (what: string) =>
    new RefusedError(`${what}: refusing to write the unit for ${s.repo}`);
  if (!repoName(s.repo)) throw refuse(`${JSON.stringify(s.repo)} is not owner/name`);
  if (!RELEASE_NAME.test(s.release))
    throw refuse(`${JSON.stringify(s.release)} is not a release name`);
  for (const path of [s.home, s.factory, ...s.program])
    if (!PLAIN.test(path)) throw refuse(`${JSON.stringify(path)} needs quoting in a unit`);
  const port = String(appPort(s.port));
  return `# Written by factory deploy (T069): do not edit; the next deploy rewrites it.
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

/** The release a unit of this template names for `repo`; undefined for anything else. */
export function unitRelease(text: string, repo: string): string | undefined {
  const starts = text.split('\n').filter((line) => line.startsWith('ExecStart='));
  const escaped = repo.replace(/[.]/g, '\\.');
  const match = new RegExp(
    `^ExecStart=\\S+(?: \\S+)* service app ${escaped} (\\S+) --port \\d+$`,
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

/**
 * Switches the app's unit to `s.release` and restarts it; refuses, after putting the previous
 * unit back or removing a first one, when any step after the rewrite fails or the app does not
 * answer and keep running. Returns the release it replaced, when the previous unit names one.
 */
export async function switchService(
  place: UnitPlace,
  s: AppService,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const name = unitName(s.repo);
  const path = join(place.dir, name);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const previous = before === undefined ? undefined : unitRelease(before, s.repo);
  const runtime = place.runtime ? ['--runtime'] : [];
  const port = `127.0.0.1:${String(s.port)}`;
  writeUnit(place, name, appUnit(s));
  let why: string;
  try {
    systemctl(env, ['daemon-reload']);
    systemctl(env, ['enable', ...runtime, name]);
    systemctl(env, ['restart', name]);
    if (!(await answersHttp(s.port, START_MS)))
      why = `the new release ${s.release} did not answer HTTP on ${port} within 30 s`;
    else if (!(await steady(env, name, STEADY_MS)))
      why = `the service of the new release ${s.release} did not stay running with one main process for 10 s after ${port} answered; something else may be answering there`;
    else return previous;
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
  const [goal, done] =
    before !== undefined
      ? [
          `switch the service back to ${previous ?? 'its previous unit'}`,
          `switched the service back to ${previous ?? 'its previous unit'}`,
        ]
      : [
          "stop, disable and remove the service's first unit",
          'stopped and disabled the service, which had no earlier unit, and removed its unit',
        ];
  if (before !== undefined) {
    step(() => {
      writeUnit(place, name, before);
    });
    step(() => systemctl(env, ['daemon-reload']));
    step(() => systemctl(env, ['restart', name]));
  } else {
    step(() => systemctl(env, ['stop', name]));
    step(() => systemctl(env, ['disable', ...runtime, name]));
    step(() => {
      rmSync(path, { force: true });
    });
    step(() => systemctl(env, ['daemon-reload']));
  }
  const undone = failed.length === 0 ? done : `tried to ${goal}, but ${failed.join('; ')}`;
  throw new RefusedError(`${why}; ${undone}; nothing was deployed`);
}
