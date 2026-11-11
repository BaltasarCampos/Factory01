// The clone's dependencies (T061, slice 28-4d; Owner decisions 2026-10-30 to 2026-11-11): for
// Define, the Builder and Test, `npm ci --ignore-scripts` before the session, in the CI sandbox's
// bubblewrap with pasta's network, no credential, the installed node and npm and the factory's
// git. A git dependency's prepare script runs whatever --ignore-scripts says, so the lockfile must
// pass the identity rule before npm runs, and the clone is read-only but for its node_modules.
import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RefusedError } from '../../cli/env.js';
import { LOCK, lockEntries } from '../../ci/lockfile.js';
import { attached } from '../../ci/network.js';
import { npmCli, probeBwrap, sandboxArgs } from '../../ci/sandbox.js';
import { fileAt } from '../../git/diff.js';
import type { RoleName } from '../../model/types.js';

/** The roles whose sessions build and test the clone's code. */
const INSTALLS: ReadonlySet<string> = new Set(['define', 'builder', 'test']);

/** How long the install may run before its sandbox is stopped, in ms. */
export const INSTALL_TIMEOUT = 10 * 60_000;

/**
 * Installs `clone`'s dependencies and returns npm's exit status. Throws a `RefusedError` when the
 * sandbox or its network could not start, so npm never ran, and an `EnvironmentError` when it
 * ran past its timeout.
 */
export type Installer = (clone: string, tmp: string, git: string) => number | null;

/** Whether the launcher installs `role`'s clone: a regular package-lock.json at its top. */
export const installs = (role: RoleName, clone: string) =>
  INSTALLS.has(role) && lstatSync(join(clone, LOCK), { throwIfNoEntry: false })?.isFile() === true;

/** The install's own folder in the session's temporary folder: its home and npm's cache. */
const installFolder = (tmp: string) => join(tmp, 'npm-install');

/** The sandbox and the command: the clone read-only but its `node_modules`, git by its path. */
export function installArgs(clone: string, tmp: string, git: string) {
  const readOnly = [clone, dirname(git)];
  return {
    args: sandboxArgs(installFolder(tmp), clone, readOnly, [join(clone, 'node_modules')]),
    argv: [process.execPath, npmCli(), 'ci', '--ignore-scripts', `--git=${git}`, '--no-audit'],
  };
}

/** The install as the launcher runs it, with the factory's own environment for bwrap and pasta. */
export const sandboxedInstall =
  (env: NodeJS.ProcessEnv, timeout = INSTALL_TIMEOUT): Installer =>
  (clone, tmp, git) => {
    const { args, argv } = installArgs(clone, tmp, git);
    // Exclusive: what the clone had at `node_modules` refused the install before this.
    mkdirSync(join(clone, 'node_modules'));
    for (const dir of ['home', 'npm-cache'])
      mkdirSync(join(installFolder(tmp), dir), { recursive: true });
    const outer = probeBwrap(
      args,
      env,
      "the clone's npm ci runs only inside bubblewrap, which failed (install it with: sudo apt install bubblewrap)",
    );
    const what =
      "the clone's npm ci gets network only through pasta, which failed (install it with: sudo apt install passt)";
    return attached(args, argv, undefined, outer, what, false, timeout).status;
  };

/** Why npm must not run on the clone, read before it does; undefined when it may. */
export function notInstallable(clone: string, env: NodeJS.ProcessEnv): string | undefined {
  const at = (name: string) => lstatSync(join(clone, name), { throwIfNoEntry: false });
  if (at('node_modules') !== undefined)
    return 'the clone has a node_modules of its own, which npm ci would empty, wherever it leads';
  if (at('npm-shrinkwrap.json') !== undefined)
    return 'the clone has an npm-shrinkwrap.json, which npm ci would read in place of package-lock.json';
  const bytes = fileAt(clone, 'HEAD', LOCK, env);
  if (bytes === undefined) return `${LOCK} could not be read at the clone's head`;
  try {
    const { problems } = lockEntries(bytes, 'HEAD');
    return problems.length === 0 ? undefined : `${String(problems.length)}: ${problems[0] ?? ''}`;
  } catch (err) {
    if (err instanceof RefusedError) return err.message;
    throw err;
  }
}

/** Undefined when npm ci passed, else why the install failed and whether npm ran. */
export function installDependencies(
  clone: string,
  tmp: string,
  git: string,
  env: NodeJS.ProcessEnv,
  install: Installer = sandboxedInstall(env),
): { npm: boolean; why: string } | undefined {
  const refused = notInstallable(clone, env);
  if (refused !== undefined) return { npm: false, why: refused };
  const status = install(clone, tmp, git);
  if (status === 0) return undefined;
  return { npm: true, why: status === null ? 'killed' : `status ${String(status)}` };
}
