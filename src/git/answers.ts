// The Owner's answers on a branch (T182; Owner decisions 2026-10-21): Spec's and Plan's
// `specs/<feature>/answers.md`, and Define's `.factory/define/answers.md`. Anyone with git on the
// branch can write the file, and a hook is not evidence, so it counts only when every commit
// since the merge base with main that changed it has one parent, changes only that file and is
// signed by a key the lists pinned on main accept, verified as main's Owner merges are. Otherwise
// the answers count as none, and the caller names the commit. Only a missing file is absent: any
// git failure throws, so it never reads as no answers.
import { spawnSync } from 'node:child_process';
import type { ReleaseKeys } from '../approvals/keys.js';
import { RefusedError } from '../cli/env.js';
import { signedUnder } from './history.js';

export interface AnswersAt {
  repo: string;
  /** The branch's tip, and its merge base with main. */
  tip: string;
  base: string;
  path: string;
  /** Main's verified copy of the key lists, never the branch's. */
  keys: ReleaseKeys;
  env?: NodeJS.ProcessEnv;
}

export type SignedAnswers =
  { text: string | undefined } | { tampered: { commit: string; reason: string } };

/** git's stdout; any failure throws. */
export function gitOut(repo: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repo,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0)
    throw new RefusedError(
      `git ${args.join(' ')} failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  return result.stdout;
}

/** A file at `ref`, or undefined only when the path is not in its tree. */
export function fileAt(
  repo: string,
  ref: string,
  path: string,
  env?: NodeJS.ProcessEnv,
): string | undefined {
  if (gitOut(repo, ['ls-tree', '--name-only', ref, '--', path], env).trim() === '')
    return undefined;
  return gitOut(repo, ['show', `${ref}:${path}`], env);
}

export function signedAnswers(a: AnswersAt): SignedAnswers {
  const git = (args: readonly string[]) => gitOut(a.repo, args, a.env);
  const lines = (out: string) => out.split('\n').filter((l) => l !== '');
  const range = `${a.base}..${a.tip}`;
  // Every commit that changed the file on any line of the branch, and every merge whose tree
  // differs there from its first parent's, even one that takes the file from its other side.
  const changes = ['rev-list', '--full-history', '--no-merges', range, '--', a.path];
  const touching = new Set(lines(git(changes)));
  for (const merge of lines(git(['rev-list', '--merges', range])))
    if (git(['diff', '--name-only', `${merge}^1`, merge, '--', a.path]).trim() !== '')
      touching.add(merge);
  for (const commit of touching) {
    // Its real parents: with a path, rev-list rewrites them to the simplified history.
    const parents = git(['rev-parse', `${commit}^@`])
      .split('\n')
      .filter((p) => p !== '');
    const tampered = (reason: string): SignedAnswers => ({ tampered: { commit, reason } });
    if (parents.length !== 1) return tampered(`a merge changes ${a.path}`);
    const changed = git([
      ...['diff-tree', '-r', '-z', '--name-only', '--no-commit-id', '--no-renames'],
      ...[parents[0] ?? '', commit],
    ])
      .split('\0')
      .filter((p) => p !== '' && p !== a.path);
    if (changed.length > 0) return tampered(`it also changes ${changed.join(', ')}`);
    if (!signedUnder(a.repo, a.keys, commit, a.env))
      return tampered('it is not signed by a listed, non-revoked Owner key');
  }
  return { text: fileAt(a.repo, a.tip, a.path, a.env) };
}
