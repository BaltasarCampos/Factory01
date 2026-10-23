// `factory merge <pr>` (contracts/cli.md, FR-007b, FR-016f, FR-016g, T068): check a pull request
// on the laptop and merge it with an Owner-signed merge commit. The checks read one checked
// context (src/merge/context.ts). In order: main's signed history (AC-073); the second-copy check,
// so a key that is no longer the newest fails before any slow step; a pause (AC-078) and a session
// the dispatcher shows running (AC-088), each a warning the Owner must confirm, since both are
// telemetry; the branch's merge rule (T143); until `factory ci formal` ships (T165), no tier 3 item
// and no change under `formal/`; for an item, the once-only rule (AC-088), the whole approval
// chain, the criterion set (AC-097), and stale head-bound waivers re-signed or the merge stops;
// for Define, its output check at the checked head; required CI and, for an item, the laptop's own
// checks; for the other branches, git's merge with main checked again by the branch's rule on an
// unsigned probe; the approval summary (AC-094). Then the signed merge (src/merge/local-merge.ts):
// of exactly the checked head for an item, of the probe's tree for the others.
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { secondCopy } from '../approvals/keys.js';
import { assertNewestKey } from '../approvals/newest-key.js';
import { checkedSet, type CheckedSet } from '../ci/ac-map.js';
import type { CommandContext } from '../cli/commands.js';
import { ExitCode, RefusedError, UsageError } from '../cli/env.js';
import { reportAt, type Git } from '../dispatcher/currency.js';
import { pendingManifest } from '../dispatcher/manifest.js';
import { mergeBase, safeDiff, safeGit, type FileChange } from '../git/diff.js';
import { checkedHead, checkedMain, type MergeContext } from '../merge/context.js';
import { verifyChain, type Chain } from '../merge/chain.js';
import {
  ciAt,
  requiredChecksAt,
  requiredJobs,
  type BranchKind,
  type JobResult,
} from '../merge/ci.js';
import { laptopChecks, type LaptopResults } from '../merge/laptop.js';
import { land, probeMerge } from '../merge/local-merge.js';
import { mergeView } from '../merge/view.js';
import { mergeRules, type RuleName } from '../merge/rules.js';
import { buildSummary, NO_FORMAL, visible } from '../notify/summary.js';
import { checkDefine } from '../stations/checks/define.js';
import { confirm, confirmPause } from '../pause/confirm.js';
import { coveredAt, signHeadBoundWaiver, viewAt, viewIssue } from './approve.js';

const NOTHING = 'nothing was merged';

async function confirmSession(ctx: CommandContext, c: MergeContext): Promise<void> {
  const manifest = pendingManifest({ projectDir: c.cwd, now: ctx.now, env: c.env }, c.head);
  if (manifest === undefined) return;
  await confirm(
    ctx,
    `the dispatcher shows a session running on ${c.branch} (station ${String(manifest.station)}, ${manifest.role}), which may still push`,
    'Merge anyway?',
    NOTHING,
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

/**
 * Define's outputs at the checked head, in order (data-model § Pull request merge checks): a
 * merge check, so a run that is incomplete or still waiting for the Owner's answers refuses.
 */
async function defineOutputs(c: MergeContext): Promise<string[]> {
  const result = await checkDefine({
    ...{ workdir: c.cwd, repo: c.config.repo, ref: c.head, mainRef: c.main },
    gh: { env: c.env },
    // Main's verified key lists: the Owner's answers must be signed under them (T182).
    answersSignedBy: c.keys,
  });
  if (result.waiting)
    throw new RefusedError(
      `the Define run at ${c.head} is waiting for the Owner's answers; ${NOTHING}`,
    );
  if (!result.complete)
    throw new RefusedError(
      `the Define output check fails at ${c.head}; ${NOTHING}:\n  ${(result.missing ?? []).map(visible).join('\n  ')}`,
    );
  return [
    `Define output check at ${c.head.slice(0, 12)}: questions, then the Owner's answers, then the brief, skeleton, 5–10 seed issues and the draft pull request`,
  ];
}

/** The branch's own check, as the summary shows it once it passed. */
const RULE_CHECK: Partial<Record<RuleName, string>> = {
  define: 'path rule: no protected path changed',
  'factory-log': 'log rules: only regular files under the log paths, each appended to',
  'factory-repository':
    "factory-repository path rule: none of the factory's own workflows or self-protection files changed",
};

/** The `Factory-Merge:` value of each branch's merge (data-model § Merge trailers). */
const TRAILER: Partial<Record<RuleName, (c: MergeContext) => string>> = {
  define: () => 'define',
  'factory-log': () => 'factory-log',
  'factory-repository': (c) => `branch ${c.branch}`,
};

/** What the checks found, and the summary shown from it; nothing here runs again. */
export interface MergeResults {
  readonly rule: RuleName;
  readonly ci: readonly JobResult[];
  readonly chain?: Chain;
  readonly laptop?: LaptopResults;
  /** The approval summary the Owner read (AC-094). */
  readonly summary?: string;
  /** The tree to land: the checked head's for an item, git's merge with main for the others. */
  readonly tree: string;
  readonly trailer: string;
}

/**
 * A Define, log or factory-repository branch: git's merge with main, its rule run again on the
 * unsigned probe of that merge, then the summary of what lands; refuse when a part is missing.
 */
function branchSummary(
  ctx: CommandContext,
  c: MergeContext,
  at: { rule: RuleName; base: string; ci: readonly JobResult[]; checks: readonly string[] },
): Pick<MergeResults, 'summary' | 'tree'> {
  const { tree, probe } = probeMerge(c);
  const again = mergeRules({ ...rulesInput(c), head: probe });
  if (again.rule !== at.rule || again.problems.length > 0)
    throw new RefusedError(
      `the ${at.rule} rule refuses the merge result of #${String(c.pr.number)} with main at ${c.main}; ${NOTHING}:\n  ${[
        ...(again.rule === at.rule ? [] : [`the merge result falls under the ${again.rule} rule`]),
        ...again.problems,
      ].join('\n  ')}`,
    );
  const lands = safeDiff(c.cwd, c.main, probe, c.env);
  const check = RULE_CHECK[at.rule];
  const summary = buildSummary({
    ...{ gate: 'merge', kind: 'merge-branch', commit: c.head },
    issue: { number: c.pr.number, title: c.pr.title, body: '', labels: [] },
    branchMerge: {
      ...{ pr: { number: c.pr.number, title: c.pr.title }, branch: c.branch, rule: at.rule },
      ...{ head: c.head, main: c.main, base: at.base, ci: at.ci },
      diffstat: lands.map((f) => ({
        ...{ path: f.path, status: f.status },
        ...{ added: f.added.length, removed: f.removed.length },
      })),
      checks: [
        ...at.checks,
        ...(check === undefined ? [] : [`${check}, at the checked head and on the merge result`]),
      ],
    },
  });
  if (!summary.ok)
    throw new RefusedError(
      `not merging: the approval summary is incomplete:\n  ${summary.missing.join('\n  ')}`,
    );
  ctx.io.stdout.write(`${summary.text}\n`);
  return { summary: summary.text, tree };
}

const rulesInput = (c: MergeContext) => ({
  ...{ repo: c.cwd, branch: c.branch, head: c.head, main: c.main, keys: c.keys },
  ...{ laptopKeys: c.laptopKeys, secondCopy: secondCopy(c.env, c.home) },
  ...{ factory: c.factory, factoryRepo: c.factoryRepo, env: c.env },
});

/**
 * Run the laptop's checks of the item, then show its merge summary (AC-094), built from what the
 * checks found; refuse when a required part is missing.
 */
/**
 * The Verify reports at the checked head as the report currency rule reads them (T179), with
 * main's history as this laptop verified it: a stale report is dropped from the files, so it
 * counts as missing, and the summary names where each was written.
 */
function currentReports(c: MergeContext, branch: string, view: ReturnType<typeof viewAt>) {
  const exit1 = (args: readonly string[]) => {
    const r = safeGit(c.cwd, args, c.env);
    if (r.status !== 0 && r.status !== 1)
      throw new RefusedError(`git ${args[0] ?? ''} failed: ${r.stderr}`);
    return { ok: r.status === 0, out: r.stdout.toString().trim() };
  };
  const run: Git = Object.assign(
    (args: readonly string[]) => {
      const { ok, out } = exit1(args);
      if (!ok) throw new RefusedError(`git ${args[0] ?? ''} failed`);
      return out;
    },
    { exit1 },
  );
  const verified = new Set(c.commits.map((m) => m.commit));
  const dir = `specs/${branch.slice('claude/'.length)}`;
  const at = (name: string) => reportAt(run, c.head, dir, `reports/${name}.md`, verified);
  const reports = { verify: at('verify'), security: at('security') };
  const files = { ...view.files };
  if (reports.verify?.staleAt !== undefined) delete files.verify;
  if (reports.security?.staleAt !== undefined) delete files.security;
  return { files, reports };
}

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
  const { files, reports } = currentReports(c, chain.branch, viewAt(project, chain.branch, c.head));
  const summary = buildSummary({
    ...{ gate: 'merge', kind: 'merge', issue: await viewIssue(project, at.issue) },
    ...{ tier: chain.tier, branch: chain.branch, commit: c.head },
    ...{ files, reports },
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
    assertNewestKey(at, NOTHING);
    await confirmPause(ctx, at, 'Merge anyway while paused?', NOTHING);
    const c = await checkedHead(at, Number(arg));
    ctx.io.stdout.write(
      `Checking #${arg}: origin/${c.branch} at ${c.head}, onto main at ${c.main}\n`,
    );
    await confirmSession(ctx, c);

    // The upgrade summary and its revoked-keys rule need the signed-release fixture of slice 35.
    if (c.branch.startsWith('factory/upgrade-'))
      throw new RefusedError(`upgrade merges come with slice 35 (T115); ${NOTHING}`);
    const result = mergeRules(rulesInput(c));
    if (result.problems.length > 0)
      throw new RefusedError(
        `the ${result.rule} rule refuses #${arg}; ${NOTHING}:\n  ${result.problems.join('\n  ')}`,
      );
    const base = mergeBase(c.cwd, c.main, c.head, c.env);
    const changes = safeDiff(c.cwd, base, c.head, c.env);
    const formal = changes.filter((f) => f.path.startsWith('formal/')).map((f) => f.path);
    if (formal.length > 0)
      throw new RefusedError(`${NO_FORMAL}: #${arg} changes ${formal.join(', ')}`);
    // An item lands as exactly its checked tree, so it must already contain main.
    if (result.rule === 'item' && base !== c.main)
      throw new RefusedError(
        `main moved since #${arg} was integrated; Integrate must merge main again before it can merge; ${NOTHING}`,
      );
    const item = result.issue === undefined ? undefined : await itemChecks(ctx, c, result.issue);
    ctx.io.stdout.write(`#${arg} passes the rule ${result.rule}\n`);
    const checks = result.rule === 'define' ? await defineOutputs(c) : [];
    const changed = changes.map((f) => f.path);
    const ci = await ciChecks(ctx, c, result.rule, changed);
    const issue = result.issue;
    let results: MergeResults;
    if (item !== undefined && issue !== undefined) {
      const tree = safeGit(c.cwd, ['rev-parse', `${c.head}^{tree}`], c.env)
        .stdout.toString('utf8')
        .trim();
      results = {
        ...{ rule: result.rule, ci, tree, trailer: `#${String(issue)}` },
        ...(await itemSummary(ctx, c, { ...item, base, changes, ci, issue })),
      };
    } else {
      const trailer = TRAILER[result.rule]?.(c);
      if (trailer === undefined)
        throw new RefusedError(`factory merge does not merge ${result.rule} branches; ${NOTHING}`);
      results = {
        ...{ rule: result.rule, ci, trailer },
        ...branchSummary(ctx, c, { rule: result.rule, base, ci, checks }),
      };
    }
    Object.freeze(results);
    await land(ctx, c, results.tree, results.trailer);
    return ExitCode.Ok;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
