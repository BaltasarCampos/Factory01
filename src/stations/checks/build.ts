// Build output check (T174; Owner decisions 2026-10-17): the Builder may stop once its work on
// the task `.station.json` names is committed and pushed. Its commits follow the dispatcher's
// manifest commit, the head the session was issued, so earlier work is never rewritten; each
// carries `Factory-Role: builder` and `Factory-Item: <issue>-<slug>`, changes only the task's
// files and never `tasks.md`, which the dispatcher ticks once CI's build-test passes. The hook runs
// no tests. Commits are read from git objects, never the work tree; origin is asked for its head.
//
// The conflict Build session, whose manifest names no task, fails closed until slice 26e-3.
import { spawnSync } from 'node:child_process';
import { EnvironmentError } from '../../cli/env.js';
import type { CheckResult } from '../../hooks/stop.js';
import { trailers } from '../../events/trace.js';
import { checkedOutBranch, featureDir } from './feature.js';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0)
    throw new EnvironmentError(
      `git ${args[0] ?? ''} failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  return result.stdout.trim();
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
  if (typeof task !== 'string' || !Array.isArray(files))
    return `${path} names no task; the conflict Build session's check comes with slice 26e-3`;
  return { task, files: files.filter((f): f is string => typeof f === 'string') };
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

  const commits = git(cwd, ['rev-list', '--reverse', '--parents', `${issued}..HEAD`])
    .split('\n')
    .filter((l) => l !== '');
  if (commits.length === 0)
    return {
      complete: false,
      missing: [`no commit after the dispatcher's manifest: commit your work on ${task.task}`],
    };
  const missing: string[] = [];
  for (const line of commits) {
    const [sha = '', ...parents] = line.split(' ');
    const message = git(cwd, ['log', '-1', '--format=%B', sha]);
    const problems: string[] = [];
    if (parents.length !== 1) problems.push('is a merge; a task session only adds commits');
    const t = trailers(message);
    if ((t.get('Factory-Role') ?? []).join() !== 'builder')
      problems.push('no Factory-Role: builder trailer');
    const items = t.get('Factory-Item') ?? [];
    if (items.length === 0) problems.push('no Factory-Item trailer');
    for (const item of items)
      if (item !== feature) problems.push(`Factory-Item: ${item} is not ${feature}`);
    for (const p of parents.length === 1 ? changed(cwd, parents[0] ?? '', sha) : [])
      if (p === `${dir}/tasks.md`)
        problems.push(`${p}: the factory ticks your task once CI's build-test passes`);
      else if (!task.files.includes(p)) problems.push(`${p}: not in ${task.task}'s files`);
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
