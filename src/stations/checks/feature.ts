// Station outputs as committed on the item branch. Checks read git objects at HEAD, never the
// work tree, so only what was committed counts; the feature folder is the checked-out branch's,
// `claude/<issue>-<slug>` → `specs/<issue>-<slug>` (T170).
import { spawnSync } from 'node:child_process';
import { EnvironmentError } from '../../cli/env.js';
import { branchFeatureDir } from '../../model/naming.js';

/** A file at HEAD, or undefined when it is not committed. */
export function committed(cwd: string, path: string): string | undefined {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'show', `HEAD:${path}`], {
    cwd,
    encoding: 'utf8',
  });
  if (result.error) throw new EnvironmentError(`could not run git: ${result.error.message}`);
  return result.status === 0 ? result.stdout : undefined;
}

/** The checked-out branch; undefined on a detached HEAD or outside a git checkout. */
export function checkedOutBranch(cwd: string): string | undefined {
  const result = spawnSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.error) throw new EnvironmentError(`could not run git: ${result.error.message}`);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** `specs/<issue>-<slug>` for the checked-out `claude/<issue>-<slug>`; any other refuses. */
export function featureDir(cwd: string): string {
  const branch = checkedOutBranch(cwd);
  const dir = branch === undefined ? undefined : branchFeatureDir(branch);
  if (dir === undefined) throw new EnvironmentError(notOnItemBranch(branch));
  return dir;
}

export const notOnItemBranch = (branch: string | undefined) =>
  `not on a work-item branch (on ${branch ?? 'no branch'}); the feature folder comes from claude/<issue>-<slug>`;

export interface FeatureFiles {
  /** Path of each file, for messages. */
  paths: Record<string, string>;
  /** Text of each committed file. */
  text: Record<string, string | undefined>;
  /** `<path>: not committed` for each file that is missing at HEAD. */
  missing: string[];
}

/** Files of the feature folder at HEAD, by name relative to the folder. */
export function featureFiles(cwd: string, names: readonly string[]): FeatureFiles {
  const dir = featureDir(cwd);
  const files: FeatureFiles = { paths: {}, text: {}, missing: [] };
  for (const name of names) {
    const path = `${dir}/${name}`;
    files.paths[name] = path;
    files.text[name] = committed(cwd, path);
    if (files.text[name] === undefined) files.missing.push(`${path}: not committed`);
  }
  return files;
}
