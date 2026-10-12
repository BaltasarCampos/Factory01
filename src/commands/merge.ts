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
import { checkedSet, type CheckedSet } from '../ci/ac-map.js';
import type { CommandContext } from '../cli/commands.js';
import { RefusedError, UsageError } from '../cli/env.js';
import { pendingManifest } from '../dispatcher/manifest.js';
import { mergeBase, safeDiff, type FileChange } from '../git/diff.js';
import { listComments } from '../github/comments.js';
import { timeline } from '../github/timeline.js';
import { checkedHead, checkedMain, type MainContext, type MergeContext } from '../merge/context.js';
import { verifyChain, type Chain } from '../merge/chain.js';
import {
  ciAt,
  requiredChecksAt,
  requiredJobs,
  type BranchKind,
  type JobResult,
} from '../merge/ci.js';
import { laptopChecks, type LaptopResults } from '../merge/laptop.js';
import { mergeView } from '../merge/view.js';
import { mergeRules, type RuleName } from '../merge/rules.js';
import { STATIONS } from '../model/types.js';
import { buildSummary, NO_FORMAL } from '../notify/summary.js';
import { derivePause, resumeEntries } from '../pause/derive.js';
import { coveredAt, signHeadBoundWaiver, viewAt, viewIssue } from './approve.js';

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
 * (AC-097); then each stale head-bound waiver offered for re-signing through approve's own waiver
 * flow. One the Owner declines, or that approve would refuse to sign, does not count at the
 * checked head, and the check it waives decides.
 */
async function itemChecks(
  ctx: CommandContext,
  c: MergeContext,
  issue: number,
): Promise<{ chain: Chain; set: CheckedSet }> {
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

  if (chain.stale.length === 0) return { chain, set };
  const project = {
    ...{ repo: c.config.repo, inboxIssue: c.config.inbox_issue },
    ...{ home: c.home, cwd: c.cwd, env: c.env },
  };
  for (const waives of chain.stale) {
    // A stale test: waiver covering no weakened test at the checked head is no longer needed.
    if (waives.startsWith('test:') && coveredAt(project, waives, c.main, c.head).length === 0) {
      ctx.io.stdout.write(
        `the waiver for ${waives} covers nothing at ${c.head}; no longer needed\n`,
      );
      continue;
    }
    ctx.io.stdout.write(`The waiver for ${waives} was signed for another head.\n`);
    const w = { issue, waives, tier: chain.tier, branch: chain.branch, head: c.head };
    try {
      await signHeadBoundWaiver(ctx, project, { ...w, main: c.main, keys: c.keys }, async () => {
        const answer = await ctx.ask(
          `Sign a new waiver for ${waives} at ${c.head.slice(0, 12)}? [y/N] `,
        );
        if (!['y', 'yes'].includes(answer.trim().toLowerCase()))
          throw new RefusedError('the Owner declined to re-sign it');
      });
    } catch (err) {
      if (!(err instanceof RefusedError)) throw err;
      ctx.io.stdout.write(
        `${err.message}\nthe waiver for ${waives} is not re-signed, so it does not count at ${c.head}; the check decides\n`,
      );
    }
  }
  // The waivers in force now, re-signed ones included.
  return { chain: await verifyChain(c, issue), set };
}

const KIND: Readonly<Record<RuleName, BranchKind | undefined>> = {
  item: 'item',
  define: 'define',
  upgrade: 'upgrade',
  'factory-log': 'log',
  'factory-repository': 'factory-repository',
  none: undefined,
};

/** The required GitHub Actions jobs green at the checked head (src/merge/ci.ts). */
async function ciChecks(
  ctx: CommandContext,
  c: MergeContext,
  rule: RuleName,
  changed: readonly string[],
): Promise<JobResult[]> {
  const kind = KIND[rule];
  if (kind === undefined)
    throw new RefusedError(`no required checks for the ${rule} rule; ${NOTHING}`);
  const pin = c.config.factory_release;
  const list = requiredChecksAt(c.factory, pin.sha, c.config.profile);
  const results = await ciAt(c.config.repo, c.head, requiredJobs(list, kind, changed), {
    env: c.env,
  });
  const bad = results.filter((r) => r.state !== 'success');
  if (bad.length > 0)
    throw new RefusedError(
      `required checks are not green at ${c.head}; ${NOTHING}:\n  ${bad.map((r) => `${r.job} (${r.workflow}): ${r.state}`).join('\n  ')}`,
    );
  ctx.io.stdout.write(`CI: ${String(results.length)} required jobs green at ${c.head}\n`);
  return results;
}

/** What the checks found, and the summary shown from it; nothing here runs again. */
export interface MergeResults {
  readonly rule: RuleName;
  readonly ci: readonly JobResult[];
  readonly chain?: Chain;
  readonly laptop?: LaptopResults;
  /** The approval summary the Owner read (AC-094). */
  readonly summary?: string;
}

/**
 * Run the laptop's checks of the item, then show its merge summary (AC-094), built from what the
 * checks found; refuse when a required part is missing.
 */
async function itemSummary(
  ctx: CommandContext,
  c: MergeContext,
  at: {
    chain: Chain;
    set: CheckedSet;
    base: string;
    changes: readonly FileChange[];
    ci: readonly JobResult[];
    issue: number;
  },
): Promise<Pick<MergeResults, 'chain' | 'laptop' | 'summary'>> {
  const { chain } = at;
  const laptop = laptopChecks(c, chain, at.set, ctx.io.stdout);
  const project = {
    ...{ repo: c.config.repo, inboxIssue: c.config.inbox_issue },
    ...{ home: c.home, cwd: c.cwd, env: c.env },
  };
  const summary = buildSummary({
    ...{ gate: 'merge', kind: 'merge', issue: await viewIssue(project, at.issue) },
    ...{ tier: chain.tier, branch: chain.branch, commit: c.head },
    files: viewAt(project, chain.branch, c.head).files,
    merge: mergeView(c, at.base, at.changes, chain, at.set, at.ci, laptop),
  });
  if (!summary.ok)
    throw new RefusedError(
      `not merging: the approval summary is incomplete:\n  ${summary.missing.join('\n  ')}`,
    );
  ctx.io.stdout.write(`${summary.text}\n`);
  return { chain, laptop, summary: summary.text };
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

    // The upgrade summary and its revoked-keys rule need the signed-release fixture of slice 35.
    if (c.branch.startsWith('factory/upgrade-'))
      throw new RefusedError(`upgrade merges come with slice 35 (T115); ${NOTHING}`);
    const result = mergeRules({
      ...{ repo: c.cwd, branch: c.branch, head: c.head, main: c.main, keys: c.keys },
      ...{ laptopKeys: c.laptopKeys, secondCopy: secondCopy(c.env, c.home) },
      ...{ factory: c.factory, factoryRepo: c.factoryRepo, env: c.env },
    });
    if (result.problems.length > 0)
      throw new RefusedError(
        `the ${result.rule} rule refuses #${arg}; ${NOTHING}:\n  ${result.problems.join('\n  ')}`,
      );
    const base = mergeBase(c.cwd, c.main, c.head, c.env);
    const changes = safeDiff(c.cwd, base, c.head, c.env);
    const formal = changes.filter((f) => f.path.startsWith('formal/')).map((f) => f.path);
    if (formal.length > 0)
      throw new RefusedError(`${NO_FORMAL}: #${arg} changes ${formal.join(', ')}`);
    const item = result.issue === undefined ? undefined : await itemChecks(ctx, c, result.issue);
    ctx.io.stdout.write(`#${arg} passes the rule ${result.rule}\n`);
    const changed = changes.map((f) => f.path);
    const ci = await ciChecks(ctx, c, result.rule, changed);
    const results: MergeResults = {
      rule: result.rule,
      ci,
      ...(item === undefined
        ? {}
        : await itemSummary(ctx, c, { ...item, base, changes, ci, issue: result.issue ?? 0 })),
    };
    Object.freeze(results);

    throw new RefusedError(`the merge itself comes with slice 22b; ${NOTHING}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
