// Station evidence for the transition table (T060): what the item's station outputs, its pull
// request, CI and main's history show. Files are read from git objects on the item branch as
// origin has it (from main once the item is merged and its branch deleted), never from a work
// tree or from events: `ci / red-green` counts only as a check run on the head of the item's
// pull request, so forged `gate_result` lines move nothing (AC-012).
//
// At Verify the required jobs come from the pinned release's `required-checks.json`, read from the
// factory clone as `factory merge` reads it, each from GitHub Actions workflow runs at the head of
// the item's pull request (T168); no report decides CI, coverage or scans.
//
// A report counts only while it is current (T178, currency.ts): once a later commit is not a
// report, a manifest, one tick or a clean merge of main, it reads as missing, so a stale conflict
// report sends nothing back and stale Verify reports start Verify again.
//
// In Build (T174) the Builder's pushed head waits for CI's `build-test`: green ticks the task the
// dispatcher issued, red issues it again with the failure, at most `retry_limit` times, and then
// holds with one alert. Nothing is ticked on a branch whose history lost that manifest commit.
//
// Release evidence, the signed deploy records on the inbox issue, is read once per pass by the
// dispatcher (released.ts, T160). Open questions are read from `spec.md`, `plan.md` and the
// Owner's `answers.md` at the branch head (T180), which counts only when the Owner signed it
// (T182, src/git/answers.ts). Not yet gathered: what Release and Ops would
// work on, so Release, Ops and blocked items start no session.
import { EnvironmentError, RefusedError } from '../cli/env.js';
import { GhError, gh, repoArg, type GhOptions } from '../github/gh.js';
import { listPrs } from '../github/prs.js';
import { ciAt, requiredChecksAt, requiredJobs } from '../merge/ci.js';
import type { MainMerges } from '../git/merges.js';
import type { ProjectConfig, RoleName, State, Tier } from '../model/types.js';
import { checkIntakeIssue } from '../stations/checks/intake.js';
import type { ReleaseKeys } from '../approvals/keys.js';
import { signedAnswers } from '../git/answers.js';
import { checkPlan } from '../stations/checks/plan.js';
import { openQuestions, parseAnswers, questionAlert } from '../stations/checks/questions.js';
import { checkSecurityReport } from '../stations/checks/security.js';
import { checkSpec } from '../stations/checks/spec.js';
import { checkVerifyReport } from '../stations/checks/verify.js';
import { conflictFailure } from '../stations/edges.js';
import { featureOf, fetchBranch, git, type BranchContext } from './branch.js';
import { branchGit, reportCurrent } from './currency.js';
import type { Candidate, StationEvidence } from './dispatch.js';
import { buildIssues, issuedRef, manifestTask, pendingManifest, testEnded } from './manifest.js';
import { STATION_OF, type DecisionAlert, type Evidence } from './transitions.js';

export interface EvidenceContext {
  projectDir: string;
  mainRef?: string;
  gh?: GhOptions;
  /** The factory clone holding the pinned release, for its `required-checks.json`. */
  factory?: string;
}

/**
 * The `ci / red-green` job's check run on `sha`: the `red-green` run of the GitHub Actions app,
 * undefined until it has completed. Advisory only: a workflow edited on the item branch could
 * report a run with this name, so `factory merge` runs its own checks and decides (T068).
 */
async function redGreen(repo: string, sha: string, options: GhOptions) {
  let out: unknown;
  try {
    out = await gh(['api', `repos/${repoArg(repo)}/commits/${sha}/check-runs`], {
      ...options,
      json: true,
    });
  } catch (err) {
    if (err instanceof GhError) return undefined;
    throw err;
  }
  const runs = (out as { check_runs?: unknown }).check_runs;
  const run = (Array.isArray(runs) ? (runs as Record<string, unknown>[]) : []).findLast(
    (r) =>
      r.name === 'red-green' &&
      r.status === 'completed' &&
      (r.app as { slug?: unknown } | null | undefined)?.slug === 'github-actions',
  );
  return run === undefined ? undefined : { head: sha, green: run.conclusion === 'success' };
}

/**
 * The required jobs at `tip`, the head of the item's pull request: the pinned release's list for
 * the `item` kind and the files the pull request changes since its merge base with main. Anything
 * unreadable holds the item in Verify, with the reason.
 */
async function requiredChecks(
  ctx: EvidenceContext,
  at: BranchContext,
  config: ProjectConfig,
  tip: string,
): Promise<NonNullable<Evidence['requiredChecks']>> {
  const waits = 'the item waits in Verify';
  try {
    if (ctx.factory === undefined)
      throw new RefusedError(`no factory clone to read required-checks.json from; ${waits}`);
    const list = requiredChecksAt(ctx.factory, config.factory_release.sha, config.profile, waits);
    const range = `${ctx.mainRef ?? 'origin/main'}...${tip}`;
    const names = git(at, ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', range]);
    const jobs = requiredJobs(
      list,
      'item',
      names.split('\0').filter((p) => p !== ''),
    );
    if (jobs.length === 0)
      throw new RefusedError(`the release pinned on main requires no job for items; ${waits}`);
    const results = await ciAt(config.repo, tip, jobs, ctx.gh ?? {});
    return { head: tip, jobs: results.map(({ job, state }) => ({ job, state })) };
  } catch (err) {
    if (err instanceof RefusedError || err instanceof GhError || err instanceof EnvironmentError)
      return { head: tip, jobs: [], unreadable: err.message };
    throw err;
  }
}

/** CI's `build-test` at `tip`, the head of the item's branch, from the pinned release's list. */
async function buildTestAt(ctx: EvidenceContext, config: ProjectConfig, tip: string) {
  try {
    if (ctx.factory === undefined)
      throw new RefusedError('no factory clone to read required-checks.json from');
    const list = requiredChecksAt(ctx.factory, config.factory_release.sha, config.profile);
    const jobs = list.jobs.filter((j) => j.job === 'build-test' && j.kinds.includes('item'));
    if (jobs.length === 0) throw new RefusedError('the pinned release requires no build-test');
    const results = await ciAt(config.repo, tip, jobs, ctx.gh ?? {});
    return results.find((r) => r.state !== 'success')?.state ?? 'success';
  } catch (err) {
    if (err instanceof RefusedError || err instanceof GhError || err instanceof EnvironmentError)
      return `unreadable: ${err.message}`;
    throw err;
  }
}

/** Build's round once the Builder has pushed: tick, issue the task again, or hold (T174). */
export type BuildRound =
  { tick: string; head: string } | { failure: string } | { hold: DecisionAlert | string };

/**
 * Build's round at `tip` for the task of the Build manifest the dispatcher last pushed; undefined
 * when it pushed none, or that task is ticked, so the open task needs a session.
 */
async function buildRound(
  ctx: EvidenceContext,
  at: BranchContext,
  config: ProjectConfig,
  branch: string,
  dir: string,
  tip: string,
  tasks: string,
): Promise<BuildRound | undefined> {
  let issued: string;
  try {
    issued = git(at, ['rev-parse', '--verify', '-q', `${issuedRef(branch)}^{commit}`]);
  } catch {
    return undefined;
  }
  const task = manifestTask(at, issued, `${dir}/.station.json`);
  if (task === undefined) return undefined;
  try {
    git(at, ['merge-base', '--is-ancestor', issued, tip]);
  } catch {
    const text = `the Build manifest the dispatcher pushed, ${issued.slice(0, 12)}, is not in the history of ${branch} at ${tip.slice(0, 12)}: the branch was rewritten, so nothing more is ticked or issued for this item; close it and file it again`;
    return { hold: { urgency: 'urgent', kind: 'tampering', text } };
  }
  if (!new RegExp(`^\\s*- \\[ \\] ${task}\\b`, 'm').test(tasks)) return undefined;
  const state = await buildTestAt(ctx, config, tip);
  if (state === 'success') return { tick: task, head: tip };
  if (['pending', 'missing'].includes(state) || state.startsWith('unreadable'))
    return { hold: `build-test ${state} at ${tip.slice(0, 12)}` };
  const red = `${task} left CI red at ${tip.slice(0, 12)}: build-test (${state})`;
  const issues = buildIssues(at, tip, dir, task, ctx.mainRef);
  if (issues <= config.retry_limit) return { failure: `Your last attempt at ${red}.` };
  const text = `${red}, after ${String(issues)} Build sessions with retry_limit ${String(config.retry_limit)}; nothing sends it on before T096: close this item and file it again`;
  return { hold: { urgency: 'info', kind: 'build-failed', text } };
}

/** The Verify role that works next, or undefined once the tier's last one has ended. */
export function nextVerifyRole(
  tier: Tier,
  ended: { tested: () => boolean; reviewed: boolean; secured: boolean },
): RoleName | undefined {
  if (tier === 1) return ended.reviewed ? undefined : 'reviewer';
  // Done only once both reports are current: a current Security report with no current review
  // means Test has ended, so the Reviewer runs.
  if (ended.reviewed) return ended.secured ? undefined : 'security';
  return ended.secured || ended.tested() ? 'reviewer' : 'test';
}

export function gatherEvidence(ctx: EvidenceContext) {
  const at: BranchContext = { projectDir: ctx.projectDir, now: () => new Date() };
  const options = ctx.gh ?? {};
  return async (
    item: Candidate,
    config: ProjectConfig,
    main: MainMerges,
    keys: ReleaseKeys,
  ): Promise<StationEvidence> => {
    const n = item.issue.number;
    const ownerMerge = main.merges.some((m) => m.value === `#${String(n)}`);
    if (item.state === 'new') {
      if (item.tier === undefined) return { ownerMerge };
      const intake = await checkIntakeIssue(config.repo, n, item.tier, options);
      return {
        ...{ ownerMerge, intakeComplete: intake.complete, needsSession: !intake.complete },
        ...(intake.duplicateOf === undefined ? {} : { duplicateOf: intake.duplicateOf }),
      };
    }
    if (item.branch === undefined) return { ownerMerge };
    const dir = `specs/${featureOf({ issue: n, branch: item.branch })}`;
    const tip = fetchBranch(at, item.branch);
    const ref = tip ?? (ownerMerge ? (ctx.mainRef ?? 'origin/main') : undefined);
    if (ref === undefined) return { ownerMerge, needsSession: true };
    const read = (name: string): string | undefined => {
      try {
        return git(at, ['show', `${ref}:${dir}/${name}`]);
      } catch {
        return undefined;
      }
    };

    // On the branch, a report counts only while current; read from main, the item is merged.
    const verified = new Set(main.commits.map((c) => c.commit));
    const report = (name: string): string | undefined => {
      const text = read(name);
      if (text === undefined || tip === undefined) return text;
      return reportCurrent(branchGit(at), tip, dir, name, verified) ? text : undefined;
    };

    const spec = read('spec.md');
    const plan = read('plan.md');
    const tasks = read('tasks.md');
    const verify = report('reports/verify.md');
    const security = report('reports/security.md');
    const integrate = report('reports/integrate.md');
    // On the branch the Owner's answers count only when the Owner signed them (T182); read from
    // main, the item is merged and main's history is verified.
    const signed =
      tip === undefined
        ? { text: read('answers.md') }
        : signedAnswers({
            ...{ repo: ctx.projectDir, tip, path: `${dir}/answers.md`, keys },
            base: git(at, ['merge-base', ctx.mainRef ?? 'origin/main', tip]),
          });
    const answers = parseAnswers('text' in signed ? signed.text : undefined);
    const specComplete = spec !== undefined && checkSpec(spec, answers).complete;
    const sizeLimit = config.size_limit_lines;
    const planComplete =
      spec !== undefined &&
      plan !== undefined &&
      tasks !== undefined &&
      checkPlan({ spec, plan, tasks, sizeLimit, answers }).complete;
    const tasksDone =
      tasks !== undefined && /^\s*- \[[xX]\] T\d+/m.test(tasks) && !/^\s*- \[ \] T\d+/m.test(tasks);
    const open = openQuestions({ spec, plan }, answers);
    const asked =
      open.length === 0
        ? {}
        : {
            questionOpen: true,
            questionAlert: questionAlert(open, `${dir}/answers.md`, item.branch),
          };
    const review = verify === undefined ? undefined : checkVerifyReport(verify);
    const failure = integrate === undefined ? undefined : conflictFailure(integrate);
    const [pr] = await listPrs(config.repo, { state: 'open', head: item.branch }, options);
    const checked = tip !== undefined && pr?.headRefOid === tip;

    // Verify's next session by the Owner's tier (T181): the Reviewer alone at tier 1; Test,
    // then the Reviewer, then Security at tier 2–3, each once the one before it has ended.
    const verifyRole =
      item.state !== 'verifying' || tip === undefined || item.tier === undefined
        ? undefined
        : nextVerifyRole(item.tier, {
            tested: () => testEnded(at, tip, ctx.mainRef),
            reviewed: verify !== undefined,
            secured: security !== undefined,
          });
    // The session the dispatcher last issued has pushed nothing yet: do not start another.
    const pending =
      tip !== undefined && pendingManifest(at, tip)?.station === STATION_OF[item.state];
    // Every Verify session the tier needs has ended, so a failing result is the Owner's to hear.
    const verifyEnded =
      item.state === 'verifying' &&
      tip !== undefined &&
      item.tier !== undefined &&
      verifyRole === undefined &&
      !pending;
    const round =
      item.state === 'building' &&
      tip !== undefined &&
      tasks !== undefined &&
      !tasksDone &&
      !pending
        ? await buildRound(ctx, at, config, item.branch, dir, tip, tasks)
        : undefined;
    const held = round !== undefined && 'hold' in round ? round.hold : undefined;
    const work: Partial<Record<State, boolean>> = {
      triaged: !specComplete,
      'spec-approved': !planComplete,
      building: !tasksDone && (round === undefined || 'failure' in round),
      verifying: verifyRole !== undefined,
      integrating: integrate === undefined,
    };
    const rg = checked ? await redGreen(config.repo, tip, options) : undefined;
    const ci =
      checked && item.state === 'verifying'
        ? await requiredChecks(ctx, at, config, tip)
        : undefined;
    return {
      ownerMerge,
      specComplete,
      draftPr: pr !== undefined,
      planComplete,
      tasksDone,
      ...(spec === undefined ? {} : { specSha: git(at, ['rev-parse', `${ref}:${dir}/spec.md`]) }),
      ...(tip === undefined ? {} : { branchHead: tip }),
      ...asked,
      ...(verifyRole === undefined ? {} : { verifyRole }),
      ...(verifyEnded ? { verifyEnded } : {}),
      ...('tampered' in signed ? { answersTampered: signed.tampered } : {}),
      ...(rg === undefined ? {} : { redGreen: rg }),
      ...(review === undefined ? {} : { verifyReport: review.checksPass }),
      ...(review === undefined ? {} : { findingsResolved: review.findingsResolved }),
      ...(ci === undefined ? {} : { requiredChecks: ci }),
      ...(security === undefined ? {} : { securityReport: checkSecurityReport(security).complete }),
      ...(failure === undefined ? {} : { failure }),
      ...(round !== undefined && 'tick' in round
        ? { tick: { task: round.tick, head: round.head } }
        : {}),
      ...(round !== undefined && 'failure' in round ? { buildFailure: round.failure } : {}),
      ...(held === undefined || typeof held === 'string' ? {} : { buildAlert: held }),
      needsSession: (work[item.state] ?? false) && !pending,
    };
  };
}
