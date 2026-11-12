// Build output check (T174; Owner decisions 2026-10-17): the Builder may stop once its work on
// the task `.station.json` names is committed. Its commits follow the dispatcher's
// manifest commit, the head the session was issued, so earlier work is never rewritten; each
// carries `Factory-Role: builder` and `Factory-Item: <issue>-<slug>`, changes only the task's
// files and never `tasks.md`, which the dispatcher ticks once CI's build-test passes. The hook runs
// no tests. Commits are read from git objects in the factory's own clone, where the Stop hook took
// the session's head; the manifest is the head the session's record names, and the launcher pushes
// the work after the session (28-6), so origin is never asked.
//
// The conflict Build session's manifest names no task and lists the files Integrate's report
// names: its first commit merges main, with the manifest commit as its first parent and a commit
// on `origin/main` as its second, and differs from git's own merge of the two only in those files.
import { EnvironmentError } from '../../cli/env.js';
import type { SessionOutput } from '../../hooks/session-commits.js';
import type { CheckResult } from '../../hooks/stop.js';
import { trailers } from '../../events/trace.js';
import { answer, featureDir } from './feature.js';

type Repo = Pick<SessionOutput, 'repo'>;

function git(at: Repo, args: readonly string[]): string {
  const { ok, out } = answer(at, args);
  if (!ok) throw new EnvironmentError(`git ${args[0] ?? ''} failed`);
  return out;
}

/** Files `commit` changes against `parent`. */
const changed = (at: Repo, parent: string, commit: string) =>
  git(at, [
    ...['diff-tree', '-r', '-z', '--name-only', '--no-commit-id', '--no-renames'],
    ...[parent, commit],
  ])
    .split('\0')
    .filter((p) => p !== '');

/**
 * The task and its files in the dispatcher's Build manifest at `commit`, the head the session's
 * record names, or why it is not one.
 */
function issuedTask(at: Repo, commit: string, path: string) {
  const parents = git(at, ['rev-list', '--parents', '-1', commit]).split(' ').slice(1);
  const [parent] = parents;
  if (
    parent === undefined ||
    parents.length !== 1 ||
    changed(at, parent, commit).join('\0') !== path
  )
    return `the head the session was issued, ${commit.slice(0, 12)}, is not a Build manifest commit changing only ${path}`;
  const manifest = JSON.parse(git(at, ['show', `${commit}:${path}`])) as Record<string, unknown>;
  const { task, files } = manifest;
  if (!Array.isArray(files)) return `${path} lists no files`;
  const listed = files.filter((f): f is string => typeof f === 'string');
  return typeof task === 'string' ? { task, files: listed } : { files: listed };
}

/** Why the conflict session's merge is not main merged in, resolving only the listed files. */
function mergeProblems(at: Repo, sha: string, parents: string[], files: readonly string[]) {
  const [ours = '', theirs] = parents;
  if (parents.length !== 2 || theirs === undefined)
    return ['does not merge main: merge origin/main first'];
  if (!answer(at, ['merge-base', '--is-ancestor', theirs, 'origin/main']).ok)
    return [`merges ${theirs.slice(0, 12)}, which is not on origin/main`];
  // Exit 1 is a merge with conflicts; its tree holds them, so resolving them shows as a change.
  // git 2.39 also exits 1 on a commit it cannot read: only a merge result counts.
  const auto = answer(at, ['merge-tree', '--write-tree', ours, theirs]).out.split('\n')[0] ?? '';
  if (!/^[0-9a-f]{40,64}$/.test(auto))
    throw new EnvironmentError(
      `git merge-tree gave no merge of ${ours.slice(0, 12)} and ${theirs.slice(0, 12)}`,
    );
  return changed(at, auto, sha)
    .filter((p) => !files.includes(p))
    .map((p) => `${p}: changed beyond git's own merge, and not a file reports/integrate.md lists`);
}

export function buildStopCheck(at: SessionOutput): CheckResult {
  const dir = featureDir(at);
  const feature = dir.slice('specs/'.length);
  const path = `${dir}/.station.json`;
  // The dispatcher's manifest is the head the clone was made from, as the record names it.
  const issued = at.head;
  const task = issuedTask(at, issued, path);
  if (typeof task === 'string') return { complete: false, missing: [task] };

  // A conflict session's merge brings main's commits in: only its own line counts.
  const conflict = task.task === undefined;
  const scope =
    task.task === undefined ? 'the files reports/integrate.md lists' : `${task.task}'s files`;
  const line = conflict ? ['--first-parent'] : [];
  const commits = git(at, [
    'rev-list',
    '--reverse',
    '--parents',
    ...line,
    `${issued}..${at.commit}`,
  ])
    .split('\n')
    .filter((l) => l !== '');
  if (commits.length === 0)
    return {
      complete: false,
      missing: [`no commit after the dispatcher's manifest: commit your work on ${scope}`],
    };
  const missing: string[] = [];
  for (const [i, entry] of commits.entries()) {
    const [sha = '', ...parents] = entry.split(' ');
    const message = git(at, ['log', '-1', '--format=%B', sha]);
    const problems: string[] = [];
    const merge = conflict && i === 0;
    if (merge) problems.push(...mergeProblems(at, sha, parents, task.files));
    else if (parents.length !== 1) problems.push('is a merge; a task session only adds commits');
    const t = trailers(message);
    if ((t.get('Factory-Role') ?? []).join() !== 'builder')
      problems.push('no Factory-Role: builder trailer');
    const items = t.get('Factory-Item') ?? [];
    if (items.length === 0) problems.push('no Factory-Item trailer');
    for (const item of items)
      if (item !== feature) problems.push(`Factory-Item: ${item} is not ${feature}`);
    for (const p of !merge && parents.length === 1 ? changed(at, parents[0] ?? '', sha) : [])
      if (p === `${dir}/tasks.md`)
        problems.push(`${p}: the factory ticks your task once CI's build-test passes`);
      else if (!task.files.includes(p)) problems.push(`${p}: not in ${scope}`);
    const subject = message.split('\n', 1)[0] ?? '';
    if (problems.length > 0) missing.push(`${sha.slice(0, 12)} ${subject}: ${problems.join('; ')}`);
  }

  return missing.length === 0 ? { complete: true } : { complete: false, missing };
}
