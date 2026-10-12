// `factory merge <pr>` (contracts/cli.md, FR-007b, FR-016f, FR-016g, T068): check a pull request
// on the laptop and merge it with an Owner-signed merge commit. The checks read one checked
// context (src/merge/context.ts). In order: main's signed history (AC-073); the second-copy check,
// so a key that is no longer the newest fails before any slow step; a pause (AC-078) and a session
// the dispatcher shows running (AC-088), each a warning the Owner must confirm, since both are
// telemetry; the branch's merge rule (T143); until `factory ci formal` ships (T165), no tier 3 item
// and no change under `formal/`; for an item, the once-only rule (AC-088), the whole approval
// chain, the criterion set (AC-097), and stale head-bound waivers re-signed or the merge stops.
//
// Slice 22a stops there: the merge itself comes with slice 22b, so every run ends refusing with
// nothing merged.
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyOf, newestKey, secondCopy } from '../approvals/keys.js';
import { ownerKeyPath } from '../approvals/sign.js';
import { checkedSet } from '../ci/ac-map.js';
import type { CommandContext } from '../cli/commands.js';
import { RefusedError, UsageError } from '../cli/env.js';
import { pendingManifest } from '../dispatcher/manifest.js';
import { mergeBase, safeDiff } from '../git/diff.js';
import { listComments } from '../github/comments.js';
import { timeline } from '../github/timeline.js';
import { checkedHead, checkedMain, type MainContext, type MergeContext } from '../merge/context.js';
import { verifyChain } from '../merge/chain.js';
import { mergeRules } from '../merge/rules.js';
import { STATIONS } from '../model/types.js';
import { NO_FORMAL } from '../notify/summary.js';
import { derivePause, resumeEntries } from '../pause/derive.js';
import { coveredAt, signHeadBoundWaiver } from './approve.js';

const NOTHING = 'nothing was merged';

/** Go on only when the Owner answers yes; the warning is telemetry, never a refusal by itself. */
async function confirm(ctx: CommandContext, warning: string, question: string): Promise<void> {
  ctx.io.stderr.write(`warning: ${warning}\n`);
  const answer = (await ctx.ask(`${question} [y/N] `)).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes')
    throw new RefusedError(`the Owner did not confirm; ${NOTHING}`);
}

/** The key this laptop signs with must be the newest listed, non-revoked key at main's pin. */
function assertNewestKey(at: MainContext): void {
  const mine = keyOf(secondCopy(at.env, at.home) ?? '');
  if (mine === undefined || mine !== newestKey(at.keys))
    throw new RefusedError(
      `finish the rotation: ${ownerKeyPath(at.home)}.pub is not the newest listed, non-revoked key of the release pinned on main (factory keygen --rotate --finish); ${NOTHING}`,
    );
}

async function confirmPause(ctx: CommandContext, at: MainContext): Promise<void> {
  const { repo, inbox_issue: inbox } = at.config;
  const options = { env: at.env };
  const resumes = resumeEntries(await listComments(repo, inbox, options), {
    ...{ keys: at.keys, secondCopy: secondCopy(at.env, at.home) },
    ...{ repo, inboxIssue: inbox },
  });
  const pause = derivePause(await timeline(repo, inbox, options), resumes);
  const paused = [
    ...(pause.line ? ['pause:line'] : []),
    ...[...pause.stations].map((s) => `pause:${STATIONS[s]}`),
  ];
  if (paused.length > 0)
    await confirm(ctx, `the line is paused (${paused.join(', ')})`, 'Merge anyway while paused?');
}

async function confirmSession(ctx: CommandContext, c: MergeContext): Promise<void> {
  const manifest = pendingManifest({ projectDir: c.cwd, now: ctx.now, env: c.env }, c.head);
  if (manifest === undefined) return;
  await confirm(
    ctx,
    `the dispatcher shows a session running on ${c.branch} (station ${String(manifest.station)}, ${manifest.role}), which may still push`,
    'Merge anyway?',
  );
}

/**
 * The item rules after T143's path rule: once only; the whole approval chain at the checked head
 * (src/merge/chain.ts); tier 3 refused; the criterion set from the verified tier and branch
 * (AC-097); then each stale head-bound waiver re-signed through approve's own waiver flow, or the
 * merge stops.
 */
async function itemChecks(ctx: CommandContext, c: MergeContext, issue: number): Promise<void> {
  const merged = c.merges.find((m) => m.value === `#${String(issue)}`);
  if (merged !== undefined)
    throw new RefusedError(
      `#${String(issue)} is already merged: main has an Owner-signed Factory-Merge: #${String(issue)} at ${merged.commit}; ${NOTHING}`,
    );
  const chain = await verifyChain(c, issue);
  if (chain.tier === 3) throw new RefusedError(`${NO_FORMAL}: factory merge refuses a tier 3 item`);

  const set = checkedSet(c.cwd, c.main, c.head, chain.tier, chain.branch, c.env);
  if (set.problems.length > 0)
    throw new RefusedError(
      `every acceptance criterion line needs one ID (AC-097); ${NOTHING}:\n  ${set.problems.join('\n  ')}`,
    );
  if (set.ids.size === 0)
    throw new RefusedError(
      `the checked set is empty: spec.md at ${c.head.slice(0, 12)} has no acceptance criteria (AC-097); ${NOTHING}`,
    );

  if (chain.stale.length === 0) return;
  const project = {
    ...{ repo: c.config.repo, inboxIssue: c.config.inbox_issue },
    ...{ home: c.home, cwd: c.cwd, env: c.env },
  };
  // A stale test: waiver covering no weakened test at the checked head is no longer needed.
  const needed = chain.stale.filter((waives) => {
    if (!waives.startsWith('test:')) return true;
    if (coveredAt(project, waives, c.main, c.head).length > 0) return true;
    ctx.io.stdout.write(`the waiver for ${waives} covers nothing at ${c.head}; no longer needed\n`);
    return false;
  });
  for (const waives of needed) {
    ctx.io.stdout.write(
      `The waiver for ${waives} was signed for another head; re-sign it at the checked head ${c.head} or the merge stops.\n`,
    );
    const w = { issue, waives, tier: chain.tier, branch: chain.branch, head: c.head };
    await signHeadBoundWaiver(ctx, project, { ...w, main: c.main, keys: c.keys }, async () => {
      const answer = await ctx.ask(
        `Sign a new waiver for ${waives} at ${c.head.slice(0, 12)}? [y/N] `,
      );
      if (!['y', 'yes'].includes(answer.trim().toLowerCase()))
        throw new RefusedError(`the stale waiver ${waives} was not re-signed; ${NOTHING}`);
    });
  }
  const still = (await verifyChain(c, issue)).stale.filter((w) => needed.includes(w));
  if (still.length > 0)
    throw new RefusedError(`a re-signed waiver does not verify at the checked head; ${NOTHING}`);
}

export async function merge(ctx: CommandContext): Promise<number> {
  const [arg = ''] = ctx.positionals;
  if (!/^[1-9]\d*$/.test(arg)) throw new UsageError(`not a pull request number: ${arg}`);
  const scratch = mkdtempSync(join(tmpdir(), 'factory-merge-'));
  try {
    const at = checkedMain(ctx.cwd, ctx.env, ctx.env.HOME ?? homedir(), scratch);
    assertNewestKey(at);
    await confirmPause(ctx, at);
    const c = await checkedHead(at, Number(arg));
    ctx.io.stdout.write(
      `Checking #${arg}: origin/${c.branch} at ${c.head}, onto main at ${c.main}\n`,
    );
    await confirmSession(ctx, c);

    const upgrade = c.branch.startsWith('factory/upgrade-');
    const options = { env: c.env };
    const pr = upgrade
      ? {
          number: c.pr.number,
          comments: await listComments(c.config.repo, c.pr.number, { ...options, thread: 'pr' }),
          labelAdds: (await timeline(c.config.repo, c.pr.number, options)).filter(
            (e) => e.event === 'labeled',
          ),
        }
      : undefined;
    const result = mergeRules({
      ...{ repo: c.cwd, branch: c.branch, head: c.head, main: c.main, keys: c.keys },
      ...{ laptopKeys: c.laptopKeys, secondCopy: secondCopy(c.env, c.home) },
      ...{ factory: c.factory, factoryRepo: c.factoryRepo, env: c.env },
      ...(pr === undefined ? {} : { pr }),
    });
    if (result.problems.length > 0)
      throw new RefusedError(
        `the ${result.rule} rule refuses #${arg}; ${NOTHING}:\n  ${result.problems.join('\n  ')}`,
      );
    const changes = safeDiff(c.cwd, mergeBase(c.cwd, c.main, c.head, c.env), c.head, c.env);
    const formal = changes.filter((f) => f.path.startsWith('formal/')).map((f) => f.path);
    if (formal.length > 0)
      throw new RefusedError(`${NO_FORMAL}: #${arg} changes ${formal.join(', ')}`);
    if (result.issue !== undefined) await itemChecks(ctx, c, result.issue);
    ctx.io.stdout.write(`#${arg} passes the rule ${result.rule}\n`);

    throw new RefusedError(`the merge itself comes with slice 22b; ${NOTHING}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
