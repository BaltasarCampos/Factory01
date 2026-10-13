// Writing a commit's files on the laptop, outside any sandbox (T069, T164; Owner decisions
// 2026-10-13). An exclusive, no-follow create guards only a path's last part: a folder on the way
// that is a link is still followed. So every folder is made here, from a real root down, before
// any file; an existing one must be a real folder; the tree's links come last, so no write passes
// through one; and a tree naming one path both a link or file and a folder, which `git mktree`
// accepts, is refused. `deploy` exports into a folder that did not exist; `writeTree` writes into
// the workspaces of `merge` and `approve`, which their sandboxed runs can write to as well.
import {
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  symlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { RefusedError } from '../cli/env.js';
import { safeGit } from './diff.js';

export interface TreeEntry {
  mode: string;
  oid: string;
  path: string;
}

/** A path git would never check out: absolute, or with an empty, `.`, `..` or `.git` part. */
export function unsafePath(path: string): boolean {
  return (
    path.startsWith('/') ||
    path
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git')
  );
}

/** Every entry of `commit`'s tree; every path is checked before anything is written. */
export function treeEntries(repo: string, commit: string, env: NodeJS.ProcessEnv): TreeEntry[] {
  const listing = safeGit(repo, ['ls-tree', '-r', '-z', '--full-tree', commit], env);
  if (listing.status !== 0) throw new RefusedError(`cannot list ${commit}: ${listing.stderr}`);
  const entries = listing.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const tab = row.indexOf('\t');
      const [mode = '', , oid = ''] = row.slice(0, tab).split(' ');
      return { mode, oid, path: row.slice(tab + 1) };
    });
  const unsafe = entries.find((e) => unsafePath(e.path));
  if (unsafe !== undefined)
    throw new RefusedError(`${commit} holds an unsafe path: ${JSON.stringify(unsafe.path)}`);
  const seen = new Set<string>();
  const folders = new Set<string>();
  for (const { path } of entries) {
    if (seen.has(path)) throw new RefusedError(`${commit} names ${JSON.stringify(path)} twice`);
    seen.add(path);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  const clash = [...folders].find((f) => seen.has(f));
  if (clash !== undefined)
    throw new RefusedError(
      `${commit} holds ${JSON.stringify(clash)} as both a link or file and a folder`,
    );
  return entries;
}

/** `path` as a real folder, made when missing; no part of it may be a link. */
export function realFolder(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) {
    realFolder(dirname(path));
    mkdirSync(path);
  } else if (!stat.isDirectory() || realpathSync(path) !== path)
    throw new RefusedError(`${path} is not a folder: refusing to write through it`);
}

const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/**
 * Writes `entries` (from `treeEntries`, gitlinks left out) into `dir`, a real folder: folders
 * first, from the top down, then files, created exclusively and never through a link, 100755 ones
 * executable, then the links.
 */
export function writeEntries(
  repo: string,
  entries: readonly TreeEntry[],
  dir: string,
  env: NodeJS.ProcessEnv,
): void {
  const folders = [
    ...new Set(
      entries.flatMap(({ path }) => {
        const parts = path.split('/');
        return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/'));
      }),
    ),
  ].sort((a, b) => a.split('/').length - b.split('/').length);
  for (const folder of folders) {
    const full = join(dir, ...folder.split('/'));
    const stat = lstatSync(full, { throwIfNoEntry: false });
    if (stat === undefined) mkdirSync(full);
    else if (!stat.isDirectory())
      throw new RefusedError(`${full} is not a folder: refusing to write through it`);
  }
  if (entries.length === 0) return;
  const batch = safeGit(
    repo,
    ['cat-file', '--batch'],
    env,
    entries.map((e) => e.oid).join('\n') + '\n',
  );
  if (batch.status !== 0) throw new RefusedError(`cannot read the blobs: ${batch.stderr}`);
  const links: [string, string][] = [];
  let at = 0;
  for (const entry of entries) {
    const header = batch.stdout.indexOf(0x0a, at);
    const size = Number(batch.stdout.subarray(at, header).toString('utf8').split(' ')[2]);
    const bytes = batch.stdout.subarray(header + 1, header + 1 + size);
    at = header + 1 + size + 1;
    const full = join(dir, ...entry.path.split('/'));
    if (entry.mode === '120000') {
      links.push([bytes.toString('utf8'), full]);
      continue;
    }
    const mode = entry.mode === '100755' ? 0o755 : 0o644;
    const fd = openSync(full, CREATE, mode);
    try {
      writeSync(fd, bytes);
      fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
  }
  for (const [target, full] of links) symlinkSync(target, full);
}

/**
 * Exports `commit`'s tree, without `.git`, into `dir`, which must not exist yet: its parent must
 * be a real folder, and `mkdir` fails when `dir` is already there. A submodule is refused.
 */
export function exportTree(
  repo: string,
  commit: string,
  dir: string,
  env: NodeJS.ProcessEnv,
): void {
  const entries = treeEntries(repo, commit, env);
  const submodule = entries.find((e) => e.mode === '160000');
  if (submodule !== undefined)
    throw new RefusedError(
      `${commit} holds a submodule at ${JSON.stringify(submodule.path)}, which a release cannot hold`,
    );
  realFolder(dirname(dir));
  try {
    mkdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST')
      throw new RefusedError(
        `${dir} already exists: a release is always exported into a new folder`,
      );
    throw err;
  }
  writeEntries(repo, entries, dir, env);
}
