// Report currency (T178): a station report counts only for the commits it saw. Branches only gain
// commits, so a report stays current while every first-parent commit after the one that last
// wrote it is one of:
//
// - a commit that changes only files under the feature's `reports/`;
// - a commit that changes only the feature's `.station.json`, or exactly one `tasks.md` checkbox
//   from `[ ]` to `[X]`, as the dispatcher writes them;
// - a commit that changes only the feature's `answers.md`, the Owner's answers (T180);
// - a clean merge of main: its second parent is on main's verified first-parent history, and its
//   tree is exactly what `git merge-tree --write-tree` makes of its two parents.
//
// Any other later commit makes the report stale. The rule reads only content: commit authors and
// trailers are agent-written and can be forged. The dispatcher and `factory merge` (T179) share it,
// each with its own git runner and its own verified history of main.
import { git, type BranchContext } from './branch.js';

/** Runs git with these arguments and returns its trimmed stdout; throws when git fails. */
export type Git = (args: readonly string[]) => string;

/** The dispatcher's runner, in its clone. */
export const branchGit =
  (at: BranchContext): Git =>
  (args) =>
    git(at, args);

/** Whether `commit`, with these parents, is a merge of main that git makes on its own. */
export function cleanMainMerge(
  run: Git,
  commit: string,
  parents: readonly string[],
  verified: ReadonlySet<string>,
): boolean {
  const [ours, theirs] = parents;
  if (parents.length !== 2 || ours === undefined || theirs === undefined) return false;
  if (!verified.has(theirs)) return false;
  try {
    // Exit 1 (a conflict) throws, like any failure: the merge is then not clean.
    const tree = run(['merge-tree', '--write-tree', ours, theirs]).split('\n')[0];
    return tree === run(['rev-parse', `${commit}^{tree}`]);
  } catch {
    return false;
  }
}

const TICK = /^(\s*- \[) (\] T\d+.*)$/;

/** Whether `path` differs between the two commits in exactly one line, a task's `[ ]` ticked. */
function oneTick(run: Git, parent: string, commit: string, path: string): boolean {
  const before = run(['show', `${parent}:${path}`]).split('\n');
  const after = run(['show', `${commit}:${path}`]).split('\n');
  if (before.length !== after.length) return false;
  const changed = before.flatMap((line, i) => (line === after[i] ? [] : [i]));
  if (changed.length !== 1) return false;
  const i = changed[0] ?? 0;
  const m = TICK.exec(before[i] ?? '');
  return m !== null && [`${m[1]}X${m[2]}`, `${m[1]}x${m[2]}`].includes(after[i] ?? '');
}

function keepsReport(
  run: Git,
  dir: string,
  commit: string,
  parents: readonly string[],
  verified: ReadonlySet<string>,
): boolean {
  if (parents.length > 1) return cleanMainMerge(run, commit, parents, verified);
  const [parent] = parents;
  if (parent === undefined) return false;
  const names = run([
    ...['diff-tree', '-r', '-z', '--name-only', '--no-commit-id', '--no-renames'],
    ...[parent, commit],
  ])
    .split('\0')
    .filter((p) => p !== '');
  if (names.length === 0) return true;
  if (names.every((p) => p.startsWith(`${dir}/reports/`))) return true;
  if (names.length !== 1) return false;
  if (names[0] === `${dir}/.station.json` || names[0] === `${dir}/answers.md`) return true;
  return names[0] === `${dir}/tasks.md` && oneTick(run, parent, commit, `${dir}/tasks.md`);
}

/** Where a report was written, and the first later commit that made it stale, if any. */
export interface ReportAt {
  wrote: string;
  staleAt?: string;
}

/**
 * Where `${dir}/${name}` at `tip` was last written, and whether it is still current: undefined when
 * no commit wrote it. `verified` holds main's verified first-parent commits.
 */
export function reportAt(
  run: Git,
  tip: string,
  dir: string,
  name: string,
  verified: ReadonlySet<string>,
): ReportAt | undefined {
  const wrote = run(['rev-list', '-1', tip, '--', `${dir}/${name}`]);
  if (wrote === '') return undefined;
  // Oldest first, so the first commit the rule does not keep is the one named.
  const later = run(['rev-list', '--first-parent', '--reverse', '--parents', `${wrote}..${tip}`]);
  const stale = later
    .split('\n')
    .filter((l) => l !== '')
    .find((line) => {
      const [commit = '', ...parents] = line.split(' ');
      return !keepsReport(run, dir, commit, parents, verified);
    });
  return stale === undefined ? { wrote } : { wrote, staleAt: stale.split(' ')[0] ?? '' };
}

/** Whether `${dir}/${name}` at `tip` was written and is still current. */
export function reportCurrent(
  run: Git,
  tip: string,
  dir: string,
  name: string,
  verified: ReadonlySet<string>,
): boolean {
  const at = reportAt(run, tip, dir, name, verified);
  return at !== undefined && at.staleAt === undefined;
}
