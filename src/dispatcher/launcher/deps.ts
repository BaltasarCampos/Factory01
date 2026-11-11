// The clone's dependencies (T061, slice 28-4d; Owner decisions 2026-10-30 to 2026-11-11): for
// Define, the Builder and Test, `npm ci --ignore-scripts` before the session, in the CI sandbox's
// bubblewrap with pasta's network, no credential, the installed node and npm and the factory's
// git. npm never reads the clone: it runs in a folder beside it holding only package.json and the
// lockfile, from the head's blobs, the lockfile checked first, since a git or link dependency's
// prepare runs whatever --ignore-scripts says; its node_modules is then renamed into the clone.
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { RefusedError } from '../../cli/env.js';
import { LOCK, lockEntries } from '../../ci/lockfile.js';
import { attached } from '../../ci/network.js';
import { npmCli, probeBwrap, sandboxArgs } from '../../ci/sandbox.js';
import { safeGit } from '../../git/diff.js';
import type { RoleName } from '../../model/types.js';

/** The roles whose sessions build and test the clone's code. */
const INSTALLS: ReadonlySet<string> = new Set(['define', 'builder', 'test']);

/** How long the install may run before its sandbox is stopped, in ms. */
export const INSTALL_TIMEOUT = 10 * 60_000;

/**
 * Runs npm ci in the install folder `dir` and returns npm's exit status. Throws a `RefusedError` when the
 * sandbox or its network could not start, so npm never ran, and an `EnvironmentError` when it
 * ran past its timeout.
 */
export type Installer = (dir: string, tmp: string, git: string) => number | null;

/** Whether the launcher installs `role`'s clone: a regular package-lock.json at its top. */
export const installs = (role: RoleName, clone: string) =>
  INSTALLS.has(role) && lstatSync(join(clone, LOCK), { throwIfNoEntry: false })?.isFile() === true;

/** The install's own folder in the session's temporary folder: its home and npm's cache. */
const installFolder = (tmp: string) => join(tmp, 'npm-install');

/** npm's settings on its command line, which no file of the project's can change. */
const PINNED = ['--registry=https://registry.npmjs.org/', '--replace-registry-host=never'];

/** The sandbox and the command: only the install folder `dir` writable, git by its path. */
export function installArgs(dir: string, tmp: string, git: string) {
  return {
    args: sandboxArgs(installFolder(tmp), dir, [dirname(git)], [dir]),
    argv: [
      process.execPath,
      npmCli(),
      'ci',
      '--ignore-scripts',
      `--git=${git}`,
      '--no-audit',
    ].concat(PINNED, ['--install-links=false', '--strict-ssl=true']),
  };
}

/** The install as the launcher runs it, with the factory's own environment for bwrap and pasta. */
export const sandboxedInstall =
  (env: NodeJS.ProcessEnv, timeout = INSTALL_TIMEOUT): Installer =>
  (dir, tmp, git) => {
    const { args, argv } = installArgs(dir, tmp, git);
    for (const sub of ['home', 'npm-cache'])
      mkdirSync(join(installFolder(tmp), sub), { recursive: true });
    const outer = probeBwrap(
      args,
      env,
      "the clone's npm ci runs only inside bubblewrap, which failed (install it with: sudo apt install bubblewrap)",
    );
    const what =
      "the clone's npm ci gets network only through pasta, which failed (install it with: sudo apt install passt)";
    return attached(args, argv, undefined, outer, what, false, timeout).status;
  };

/** git in the clone, without the Owner's config; throws on any failure. */
function cloneGit(clone: string, args: readonly string[], env: NodeJS.ProcessEnv): Buffer {
  const run = safeGit(clone, ['--literal-pathspecs', ...args], env);
  if (run.status !== 0) throw new Error(`git ${args[0] ?? ''} failed: ${run.stderr}`);
  return run.stdout;
}

/**
 * package.json and the lockfile as the head's blobs, never the checked-out files, which a
 * `.gitattributes` can re-encode; or why npm must not run on the clone.
 */
function installFiles(clone: string, env: NodeJS.ProcessEnv): Map<string, Buffer> | string {
  const at = (name: string) => lstatSync(join(clone, name), { throwIfNoEntry: false });
  if (at('node_modules') !== undefined)
    return 'the clone has a node_modules of its own: remove it from the branch';
  if (at('npm-shrinkwrap.json') !== undefined)
    return "the clone has an npm-shrinkwrap.json, which CI's npm ci would read: remove it from the branch";
  const files = new Map<string, Buffer>();
  const listed = cloneGit(clone, ['ls-tree', '-z', 'HEAD', '--', 'package.json', LOCK], env);
  for (const line of listed.toString('utf8').split('\0').filter(Boolean)) {
    const [meta = '', path = ''] = line.split('\t');
    const [mode, type, oid = ''] = meta.split(' ');
    if (mode === '100644' && type === 'blob')
      files.set(path, cloneGit(clone, ['cat-file', 'blob', oid], env));
  }
  const lock = files.get(LOCK);
  if (lock === undefined || !files.has('package.json'))
    return `package.json and ${LOCK} must both be regular files at the clone's head`;
  try {
    const { problems } = lockEntries(lock, 'HEAD', true);
    return problems.length === 0 ? files : `${String(problems.length)}: ${problems[0] ?? ''}`;
  } catch (err) {
    if (err instanceof RefusedError) return err.message;
    throw err;
  }
}

/**
 * Undefined when npm ci passed and its node_modules is in the clone, else why the install failed
 * and whether npm ran. The install folder, beside the clone, is removed whatever happens.
 */
export function installDependencies(
  clone: string,
  tmp: string,
  git: string,
  env: NodeJS.ProcessEnv,
  install: Installer = sandboxedInstall(env),
): { npm: boolean; why: string } | undefined {
  const files = installFiles(clone, env);
  if (typeof files === 'string') return { npm: false, why: files };
  const dir = join(dirname(clone), `${basename(clone)}.install`);
  rmSync(dir, { recursive: true, force: true });
  try {
    mkdirSync(dir, { mode: 0o700 });
    for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes, { flag: 'wx' });
    const status = install(dir, tmp, git);
    if (status !== 0)
      return { npm: true, why: status === null ? 'killed' : `status ${String(status)}` };
    const built = join(dir, 'node_modules');
    if (lstatSync(built, { throwIfNoEntry: false })?.isDirectory() === true)
      renameSync(built, join(clone, 'node_modules'));
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
