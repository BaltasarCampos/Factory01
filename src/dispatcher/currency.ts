// Report currency (T178): a station report counts only for the commits it saw. Branches only gain
// commits, so a report stays current while every first-parent commit after the one that last
// wrote it is one of:
//
// - a commit that changes only files under the feature's `reports/`;
// - a commit that changes only the feature's `.station.json`, or exactly one `tasks.md` checkbox
//   from `[ ]` to `[X]`, as the dispatcher writes them;
// - a clean merge of main: its second parent is on main's verified first-parent history, and its
//   tree is exactly what `git merge-tree --write-tree` makes of its two parents.
//
// Any other later commit makes the report stale. The rule reads only content: commit authors and
// trailers are agent-written and can be forged.
import { git, type BranchContext } from './branch.js';

/** Whether `commit`, with these parents, is a merge of main that git makes on its own. */
export function cleanMainMerge(
  at: BranchContext,
  commit: string,
  parents: readonly string[],
  verified: ReadonlySet<string>,
): boolean {
  const [ours, theirs] = parents;
  if (parents.length !== 2 || ours === undefined || theirs === undefined) return false;
  if (!verified.has(theirs)) return false;
  try {
    // Exit 1 (a conflict) throws, like any failure: the merge is then not clean.
    const tree = git(at, ['merge-tree', '--write-tree', ours, theirs]).split('\n')[0];
    return tree === git(at, ['rev-parse', `${commit}^{tree}`]);
  } catch {
    return false;
  }
}

const TICK = /^(\s*- \[) (\] T\d+.*)$/;

/** Whether `path` differs between the two commits in exactly one line, a task's `[ ]` ticked. */
function oneTick(at: BranchContext, parent: string, commit: string, path: string): boolean {
  const before = git(at, ['show', `${parent}:${path}`]).split('\n');
  const after = git(at, ['show', `${commit}:${path}`]).split('\n');
  if (before.length !== after.length) return false;
  const changed = before.flatMap((line, i) => (line === after[i] ? [] : [i]));
  if (changed.length !== 1) return false;
  const i = changed[0] ?? 0;
  const m = TICK.exec(before[i] ?? '');
  return m !== null && [`${m[1]}X${m[2]}`, `${m[1]}x${m[2]}`].includes(after[i] ?? '');
}

function keepsReport(
  at: BranchContext,
  dir: string,
  commit: string,
  parents: readonly string[],
  verified: ReadonlySet<string>,
): boolean {
  if (parents.length > 1) return cleanMainMerge(at, commit, parents, verified);
  const [parent] = parents;
  if (parent === undefined) return false;
  const names = git(at, [
    ...['diff-tree', '-r', '-z', '--name-only', '--no-commit-id', '--no-renames'],
    ...[parent, commit],
  ])
    .split('\0')
    .filter((p) => p !== '');
  if (names.length === 0) return true;
  if (names.every((p) => p.startsWith(`${dir}/reports/`))) return true;
  if (names.length !== 1) return false;
  if (names[0] === `${dir}/.station.json`) return true;
  return names[0] === `${dir}/tasks.md` && oneTick(at, parent, commit, `${dir}/tasks.md`);
}

/**
 * Whether `${dir}/${name}` at `tip` is current: false when no commit wrote it, or when a later
 * first-parent commit is not one the rule keeps. `verified` holds main's verified first-parent
 * commits.
 */
export function reportCurrent(
  at: BranchContext,
  tip: string,
  dir: string,
  name: string,
  verified: ReadonlySet<string>,
): boolean {
  const wrote = git(at, ['rev-list', '-1', tip, '--', `${dir}/${name}`]);
  if (wrote === '') return false;
  const later = git(at, ['rev-list', '--first-parent', '--parents', `${wrote}..${tip}`]);
  return later
    .split('\n')
    .filter((l) => l !== '')
    .every((line) => {
      const [commit = '', ...parents] = line.split(' ');
      return keepsReport(at, dir, commit, parents, verified);
    });
}
