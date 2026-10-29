// Paths for the guards (T084, T085): a path as a session names it, where it really is, and
// whether `deny_read` names it. A rule applies when either the named path or its real location
// matches, as Claude Code's own deny rules do, so a symlink cannot hide a denied file.
import { lstatSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { matchesPath, type Policy } from './policy.js';

/** A path the guards could not resolve: a dangling symlink, or an error but a missing file. */
export class PathError extends Error {}

/** `path` with `~` or `~/` as home, made absolute from `cwd`. */
export const absolute = (path: string, cwd: string, home: string) =>
  path === '~' || path.startsWith('~/') ? home + path.slice(1) : posix.resolve(cwd, path);

const code = (error: unknown) => (error as NodeJS.ErrnoException).code ?? String(error);

/**
 * Where the absolute `path` really is: its deepest existing part resolved, the rest appended. A
 * dangling symlink, or any error but a missing file, throws, so a read failure is never "nothing
 * there".
 */
export function realPath(path: string): string {
  let rest = '';
  for (let at = path; ; at = posix.dirname(at)) {
    try {
      return posix.join(realpathSync(at), rest);
    } catch (error) {
      if (code(error) !== 'ENOENT') throw new PathError(`${path}: ${code(error)}`);
      let linked = true;
      try {
        lstatSync(at);
      } catch (missing) {
        if (code(missing) !== 'ENOENT') throw new PathError(`${path}: ${code(missing)}`);
        linked = false;
      }
      if (linked) throw new PathError(`${at} is a symlink to nothing`);
      if (at === '/') throw new PathError(`${path}: no part of it exists`);
      rest = posix.join(posix.basename(at), rest);
    }
  }
}

/** The `deny_read` pattern naming the absolute `path`: one under home, or one at any depth. */
export const deniedRead = (policy: Policy, home: string, path: string) => {
  const fromHome = posix.relative(home, path);
  return policy.denyRead.find((pattern) =>
    pattern.startsWith('~/')
      ? !fromHome.startsWith('..') && matchesPath(pattern.slice(2), fromHome)
      : matchesPath(pattern, path.slice(1)),
  );
};

/** The kernel's folders: `/proc/<pid>/environ` shows a session's environment, its gh token too. */
const SYSTEM = ['/proc', '/sys', '/dev'];

/** The kernel folder holding the absolute `path`, `/dev/null` aside; undefined for none (T061). */
export const systemFolder = (path: string) =>
  path === '/dev/null'
    ? undefined
    : SYSTEM.find((folder) => path === folder || inside(folder, path) !== undefined);

/** `path` relative to the folder `root`, or undefined when it is not inside it. */
export const inside = (root: string, path: string) => {
  const relative = posix.relative(root, path);
  return relative === '' || relative.startsWith('..') || posix.isAbsolute(relative)
    ? undefined
    : relative;
};
