// The clone's dependencies (T061, slice 28-4d; Owner decisions 2026-10-30 and 2026-11-10): for
// Define, the Builder and Test, when the clone has a package-lock.json, the launcher runs `npm ci
// --ignore-scripts` before the session, in the CI sandbox's bubblewrap, with network through
// pasta for the install alone: no home, no credential, npm's cache in the session's temporary
// folder, the installed node and npm, never the clone's, and git by the factory's own real path,
// which the clone's .npmrc cannot change. Its own timeout stops everything in the sandbox.
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { attached } from '../../ci/network.js';
import { npmCli, probeBwrap, sandboxArgs } from '../../ci/sandbox.js';
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
  INSTALLS.has(role) &&
  lstatSync(join(clone, 'package-lock.json'), { throwIfNoEntry: false })?.isFile() === true;

/** The sandbox and the command: the clone writable, the session's temporary folder as `work`. */
export function installArgs(clone: string, tmp: string, git: string) {
  return {
    args: sandboxArgs(tmp, clone, [dirname(git)], [clone]),
    argv: [process.execPath, npmCli(), 'ci', '--ignore-scripts', `--git=${git}`, '--no-audit'],
  };
}

/** The install as the launcher runs it, with the factory's own environment for bwrap and pasta. */
export const sandboxedInstall =
  (env: NodeJS.ProcessEnv, timeout = INSTALL_TIMEOUT): Installer =>
  (clone, tmp, git) => {
    const { args, argv } = installArgs(clone, tmp, git);
    const outer = probeBwrap(
      args,
      env,
      "the clone's npm ci runs only inside bubblewrap, which failed (install it with: sudo apt install bubblewrap)",
    );
    const what =
      "the clone's npm ci gets network only through pasta, which failed (install it with: sudo apt install passt)";
    return attached(args, argv, undefined, outer, what, false, timeout).status;
  };
