// The signed merge `factory merge` makes once every check passed and the Owner read the summary
// (T068, data-model § Pull request merge checks). The merge commit is `git commit-tree -S` of the
// tree to land, with parents main and the checked head: no `git merge`, checkout, index or hook,
// and nothing from the Owner's working copy. It is verified with the key lists pinned at main, as
// the next history walk will verify it, then pushed with the head branch's deletion in one atomic
// push whose lease lets it land only if main is still the main checked. A pull request whose head
// moved after the check is closed with a comment naming the merged commit; one GitHub already
// marked merged or closed is only commented on, and never makes the merge fail.
//
// A Define, log or factory-repository branch may be behind main, so its tree is git's merge of
// the two, and `probeMerge` gives the branch's rule an unsigned commit of that tree to check
// before the Owner is asked: what lands is what was checked.
import { spawnSync } from 'node:child_process';
import { ownerKeyPath } from '../approvals/sign.js';
import type { CommandContext } from '../cli/commands.js';
import { RefusedError } from '../cli/env.js';
import { signedUnder } from '../git/history.js';
import { safeGit } from '../git/diff.js';
import { signedCommitTree } from '../git/sign.js';
import { postComment } from '../github/comments.js';
import { closePr, viewPr } from '../github/prs.js';
import { visible } from '../notify/summary.js';
import type { MergeContext } from './context.js';

const NOTHING = 'nothing was merged';
/** Head branches that persist after their merge (data-model § Pull request merge checks). */
const PERSIST = ['claude/define', 'claude/factory-log'];

function git(c: MergeContext, args: readonly string[]) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: c.cwd,
    env: c.env,
    encoding: 'utf8',
  });
  if (result.error !== undefined) throw new RefusedError(`cannot run git: ${result.error.message}`);
  return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr.trim() };
}

/** Who makes the probe commit: unmistakably not the Owner, whatever the clone's config says. */
const PROBE = ['user', 'author', 'committer'].flatMap((who) => [
  ...['-c', `${who}.name=factory probe`, '-c', `${who}.email=probe@invalid`],
]);

/**
 * Git's merge of the checked head into main: the tree `merge-tree --write-tree` gives, refused on
 * any conflict, and an unsigned probe commit of it with the merge's own parents, main and the
 * checked head, for the branch's rule to check as its head: its merge base is main, so the rule
 * sees exactly what lands. No ref ever names the probe, and it is never pushed.
 */
export function probeMerge(c: MergeContext): { tree: string; probe: string } {
  const n = String(c.pr.number);
  const merged = safeGit(
    c.cwd,
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', c.main, c.head],
    c.env,
  );
  const [tree = '', ...paths] = merged.stdout.toString('utf8').split('\0');
  if (merged.status === 1) {
    const conflicted = [...new Set(paths.filter((p) => p !== ''))].map(visible).join(', ');
    throw new RefusedError(
      `#${n} conflicts with main in ${conflicted}; it needs a rebase before it can merge; ${NOTHING}`,
    );
  }
  if (merged.status !== 0 || !/^[0-9a-f]{40,64}$/.test(tree))
    throw new RefusedError(`git merge-tree failed: ${merged.stderr}; ${NOTHING}`);
  const made = safeGit(
    c.cwd,
    [...PROBE, 'commit-tree', '--no-gpg-sign', tree, '-p', c.main, '-p', c.head],
    c.env,
    `factory merge probe of #${n}: never pushed\n`,
  );
  const probe = made.stdout.toString('utf8').trim();
  if (made.status !== 0 || !/^[0-9a-f]{40,64}$/.test(probe))
    throw new RefusedError(`cannot make the probe commit: ${made.stderr}; ${NOTHING}`);
  return { tree, probe };
}

/** The commit `ref` names on origin now, or '' when it is gone. */
const remote = (c: MergeContext, ref: string) =>
  git(c, ['ls-remote', 'origin', ref]).out.split(/\s/)[0] ?? '';

/**
 * Ask, sign, verify and push the merge of `tree` with the trailer `Factory-Merge: <trailer>`;
 * returns the merge commit.
 */
export async function land(
  ctx: CommandContext,
  c: MergeContext,
  tree: string,
  trailer: string,
): Promise<string> {
  const n = String(c.pr.number);
  const answer = await ctx.ask(`Merge #${n} into main? [y/N] `);
  if (!['y', 'yes'].includes(answer.trim().toLowerCase()))
    throw new RefusedError(`the Owner did not confirm the merge; ${NOTHING}`);

  const message = `Merge #${n} from ${c.branch}\n\nFactory-Merge: ${trailer}\n`;
  const signing = { repo: c.cwd, keyPath: ownerKeyPath(c.home), env: c.env };
  const merge = signedCommitTree(
    { ...signing, stdinIsTTY: ctx.stdinIsTTY },
    tree,
    [c.main, c.head],
    message,
  );
  if (git(c, ['rev-parse', `${merge}^{tree}`]).out !== tree)
    throw new RefusedError(`the merge commit's tree is not the tree checked; ${NOTHING}`);
  // The next walk checks this commit with the pin at its first parent, main; one it rejects could
  // never leave main, and the line would stop for good.
  if (!signedUnder(c.cwd, c.keys, merge, c.env))
    throw new RefusedError(
      'your signing key is not accepted by the release pinned on main; nothing was pushed',
    );

  const branchRef = `refs/heads/${c.branch}`;
  const headBefore = remote(c, branchRef);
  const deletion = PERSIST.includes(c.branch) ? [] : [`:${branchRef}`];
  const pushed = git(c, [
    ...['push', '-q', '--atomic', `--force-with-lease=refs/heads/main:${c.main}`, 'origin'],
    ...[`${merge}:refs/heads/main`, ...deletion],
  ]);
  if (!pushed.ok) {
    const main = remote(c, 'refs/heads/main');
    throw new RefusedError(
      main !== '' && main !== c.main
        ? `main moved since ${c.main}, so the push was rejected; ${NOTHING}; run merge again`
        : `the push was refused: ${pushed.err}; ${NOTHING}`,
    );
  }
  ctx.io.stdout.write(`Merged #${n} into main: ${merge}\n`);
  await closeIfMoved(ctx, c, merge, headBefore);
  ctx.io.stdout.write('run git pull --ff-only to update your checkout\n');
  return merge;
}

/** A head pushed after the check was not merged: say so on the pull request, and close it. */
async function closeIfMoved(
  ctx: CommandContext,
  c: MergeContext,
  merge: string,
  headBefore: string,
): Promise<void> {
  const options = { env: c.env };
  try {
    const pr = await viewPr(c.config.repo, c.pr.number, options);
    const moved = [headBefore, pr.headRefOid].find((h) => h !== '' && h !== c.head);
    if (moved === undefined) return;
    const comment = `Merged ${c.head} as ${merge}. ${moved}, pushed after the check, was not merged; open a new pull request for it.`;
    if (pr.state === 'OPEN') await closePr(c.config.repo, c.pr.number, { comment }, options);
    else await postComment(c.config.repo, c.pr.number, comment, { ...options, thread: 'pr' });
  } catch (err) {
    // The merge is on main; a pull request GitHub already closed must not make it look failed.
    const why = err instanceof Error ? err.message : String(err);
    ctx.io.stderr.write(
      `warning: #${String(c.pr.number)} was merged, but its pull request could not be closed or commented on: ${why}\n`,
    );
  }
}
