// `factory ci append-only` (contracts/ci-checks.md, research R12, FR-028a): event logs only grow
// at the end (AC-065), and `claude/factory-log` holds only regular text files under the log
// paths, each growing at the end (AC-081, AC-082). CI runs it for early feedback; `factory merge`
// repeats it on the laptop and trusts only its own result.
import { RefusedError } from '../cli/env.js';
import { appendOnly, resolveCommit, safeDiff, safeGit } from '../git/diff.js';

export const LOG_BRANCH = 'claude/factory-log';
export const LOG_PATHS = [
  '.factory/events/',
  '.factory/ops/',
  '.factory/lessons/',
  '.factory/releases/',
];
const EVENT_LOG = /^specs\/.+\/events\.jsonl$/;

/** CI's `before` commit on the first push of a branch. */
const NO_COMMIT = /^(0{40}|0{64})$/;

/**
 * Findings, empty when the check passes. `logBranch` selects the log rules; `push` the ancestor
 * rule. A push must not rewrite history (a rewrite could drop lines no diff shows), so `base`
 * must be an ancestor of `head`, except on a branch's first push, whose all-zeros `base` is
 * checked from the merge base with main. A pull request, and `factory merge`, is checked from
 * the merge base of `base` and `head`, so commits main gained since do not count.
 */
export function checkAppendOnly(
  repo: string,
  base: string,
  head: string,
  options: { logBranch: boolean; push?: boolean; env?: NodeJS.ProcessEnv; mainRef?: string },
): string[] {
  const env = options.env ?? process.env;
  const to = resolveCommit(repo, head, env);
  const mergeBase = (from: string) => {
    const found = safeGit(repo, ['merge-base', from, to], env);
    if (found.status !== 0) throw new RefusedError(`${from} and ${to} share no history`);
    return found.stdout.toString().trim();
  };
  let start: string;
  if (options.push !== true) start = mergeBase(resolveCommit(repo, base, env));
  else if (NO_COMMIT.test(base))
    start = mergeBase(resolveCommit(repo, options.mainRef ?? 'origin/main', env));
  else {
    const from = resolveCommit(repo, base, env);
    if (safeGit(repo, ['merge-base', '--is-ancestor', from, to], env).status !== 0)
      return [`history rewritten: ${from} is not an ancestor of ${to}`];
    start = from;
  }

  const findings: string[] = [];
  for (const change of safeDiff(repo, start, to, env)) {
    const { path } = change;
    if (!options.logBranch && !EVENT_LOG.test(path)) continue;
    const found = (what: string) => findings.push(`${path}: ${what}`);
    if (options.logBranch && !LOG_PATHS.some((p) => path.startsWith(p)))
      found(`outside the log paths (${LOG_PATHS.join(', ')})`);
    if (change.status === 'deleted') {
      found('deleted');
      continue;
    }
    if (change.type !== 'regular') {
      found(`not a regular text file (${change.type})`);
      continue;
    }
    if (change.gitFile) found('.git* file');
    if (change.newMode !== '100644') found('executable bit');
    if (!appendOnly(repo, change, env)) found('an existing line was edited, deleted or moved');
  }
  return findings;
}
