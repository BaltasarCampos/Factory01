// Build output check (T174; Owner decisions 2026-10-17): the Builder may stop once its work on
// the task `.station.json` names is committed and pushed. Its commits follow the dispatcher's
// manifest commit, the head the session was issued, so earlier work is never rewritten; each
// carries `Factory-Role: builder` and `Factory-Item: <issue>-<slug>`, changes only the task's
// files and never `tasks.md`, which the dispatcher ticks once CI's build-test passes. The hook runs
// no tests. Commits are read from git objects, never the work tree; origin is asked for its head.
//
// The conflict Build session's manifest names no task and lists the files Integrate's report
// names: its first commit merges main, with the manifest commit as its first parent and a commit
// on `origin/main` as its second, and differs from git's own merge of the two only in those files.
import { spawnSync } from 'node:child_process';
import { EnvironmentError } from '../../cli/env.js';
import type { CheckResult } from '../../hooks/stop.js';
import { trailers } from '../../events/trace.js';
import { checkedOutBranch, featureDir } from './feature.js';

/** Git's exit, 0 or 1, and output; any other failure throws. */
function answer(cwd: string, args: readonly string[]) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error === undefined && (result.status === 0 || result.status === 1))
    return { ok: result.status === 0, out: result.stdout.trim() };
  throw new EnvironmentError(
    `git ${args[0] ?? ''} failed: ${result.error?.message ?? result.stderr.trim()}`,
  );
}

function git(cwd: string, args: readonly string[]): string {
  const { ok, out } = answer(cwd, args);
  if (!ok) throw new EnvironmentError(`git ${args[0] ?? ''} failed`);
  return out;
}

/** Files `commit` changes against `parent`. */
const changed = (cwd: string, parent: string, commit: string) =>
  git(cwd, [
    ...['diff-tree', '-r', '-z', '--name-only', '--no-commit-id', '--no-renames'],
    ...[parent, commit],
  ])
    .split('\0')
    .filter((p) => p !== '');

/** The task and its files in the dispatcher's Build manifest at `commit`, or why it is not one. */
function issuedTask(cwd: string, commit: string, path: string) {
  const subject = git(cwd, ['log', '-1', '--format=%s', commit]);
  const parents = git(cwd, ['rev-list', '--parents', '-1', commit]).split(' ').slice(1);
  const [parent] = parents;
  if (
    subject !== 'Dispatcher: station 4 (builder) manifest' ||
    parent === undefined ||
    parents.length !== 1 ||
    changed(cwd, parent, commit).join('\0') !== path
  )
    return `the last commit to change ${path} is not the dispatcher's Build manifest commit`;
  const manifest = JSON.parse(git(cwd, ['show', `${commit}:${path}`])) as Record<string, unknown>;
  const { task, files } = manifest;
  if (!Array.isArray(files)) return `${path} lists no files`;
  const listed = files.filter((f): f is string => typeof f === 'string');
  return typeof task === 'string' ? { task, files: listed } : { files: listed };
}

/** Why the conflict session's merge is not main merged in, resolving only the listed files. */
function mergeProblems(cwd: string, sha: string, parents: string[], files: readonly string[]) {
  const [ours = '', theirs] = parents;
  if (parents.length !== 2 || theirs === undefined)
    return ['does not merge main: merge origin/main first'];
  if (!answer(cwd, ['merge-base', '--is-ancestor', theirs, 'origin/main']).ok)
    return [`merges ${theirs.slice(0, 12)}, which is not on origin/main`];
  // Exit 1 is a merge with conflicts; its tree holds them, so resolving them shows as a change.
  // git 2.39 also exits 1 on a commit it cannot read: only a merge result counts.
  const auto = answer(cwd, ['merge-tree', '--write-tree', ours, theirs]).out.split('\n')[0] ?? '';
  if (!/^[0-9a-f]{40,64}$/.test(auto))
    throw new EnvironmentError(
      `git merge-tree gave no merge of ${ours.slice(0, 12)} and ${theirs.slice(0, 12)}`,
    );
  return changed(cwd, auto, sha)
    .filter((p) => !files.includes(p))
    .map((p) => `${p}: changed beyond git's own merge, and not a file reports/integrate.md lists`);
}

export function buildStopCheck(cwd: string): CheckResult {
  const dir = featureDir(cwd);
  const feature = dir.slice('specs/'.length);
  const path = `${dir}/.station.json`;
  const issued = git(cwd, ['log', '--first-parent', '-1', '--format=%H', 'HEAD', '--', path]);
  if (issued === '')
    return { complete: false, missing: [`no dispatcher manifest commit for ${path} on HEAD`] };
  const task = issuedTask(cwd, issued, path);
  if (typeof task === 'string') return { complete: false, missing: [task] };

  // A conflict session's merge brings main's commits in: only its own line counts.
  const conflict = task.task === undefined;
  const scope =
    task.task === undefined ? 'the files reports/integrate.md lists' : `${task.task}'s files`;
  const line = conflict ? ['--first-parent'] : [];
  const commits = git(cwd, ['rev-list', '--reverse', '--parents', ...line, `${issued}..HEAD`])
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
    const message = git(cwd, ['log', '-1', '--format=%B', sha]);
    const problems: string[] = [];
    const merge = conflict && i === 0;
    if (merge) problems.push(...mergeProblems(cwd, sha, parents, task.files));
    else if (parents.length !== 1) problems.push('is a merge; a task session only adds commits');
    const t = trailers(message);
    if ((t.get('Factory-Role') ?? []).join() !== 'builder')
      problems.push('no Factory-Role: builder trailer');
    const items = t.get('Factory-Item') ?? [];
    if (items.length === 0) problems.push('no Factory-Item trailer');
    for (const item of items)
      if (item !== feature) problems.push(`Factory-Item: ${item} is not ${feature}`);
    for (const p of !merge && parents.length === 1 ? changed(cwd, parents[0] ?? '', sha) : [])
      if (p === `${dir}/tasks.md`)
        problems.push(`${p}: the factory ticks your task once CI's build-test passes`);
      else if (!task.files.includes(p)) problems.push(`${p}: not in ${scope}`);
    const subject = message.split('\n', 1)[0] ?? '';
    if (problems.length > 0) missing.push(`${sha.slice(0, 12)} ${subject}: ${problems.join('; ')}`);
  }

  const branch = checkedOutBranch(cwd) ?? '';
  const head = git(cwd, ['rev-parse', 'HEAD']);
  let origin: string;
  try {
    const line = git(cwd, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
    origin = line === '' ? 'absent' : (line.split('\t')[0] ?? '');
  } catch (err) {
    if (!(err instanceof EnvironmentError)) throw err;
    origin = `unreadable (${err.message})`;
  }
  if (origin !== head) {
    const at = /^[0-9a-f]{40}$/.test(origin) ? origin.slice(0, 12) : origin;
    missing.push(`HEAD ${head.slice(0, 12)} is not pushed: origin's ${branch} is ${at}`);
  }
  return missing.length === 0 ? { complete: true } : { complete: false, missing };
}
