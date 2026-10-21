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
// Release evidence, the signed deploy records on the inbox issue, is read once per pass by the
// dispatcher (released.ts, T160). Open questions are read from `spec.md`, `plan.md` and the
// Owner's `answers.md` at the branch head (T180). Not yet gathered: what Release and Ops would
// work on, so Release, Ops and blocked items start no session.
import { EnvironmentError, RefusedError } from '../cli/env.js';
import { GhError, gh, repoArg, type GhOptions } from '../github/gh.js';
import { listPrs } from '../github/prs.js';
import { ciAt, requiredChecksAt, requiredJobs } from '../merge/ci.js';
import type { MainMerges } from '../git/merges.js';
import type { ProjectConfig, State } from '../model/types.js';
import { checkIntakeIssue } from '../stations/checks/intake.js';
import { checkPlan } from '../stations/checks/plan.js';
import { openQuestions, parseAnswers, questionAlert } from '../stations/checks/questions.js';
import { checkSecurityReport } from '../stations/checks/security.js';
import { checkSpec } from '../stations/checks/spec.js';
import { checkVerifyReport } from '../stations/checks/verify.js';
import { conflictFailure } from '../stations/edges.js';
import { featureOf, fetchBranch, git, type BranchContext } from './branch.js';
import { branchGit, reportCurrent } from './currency.js';
import type { Candidate, StationEvidence } from './dispatch.js';
import { pendingManifest } from './manifest.js';
import { STATION_OF, type Evidence } from './transitions.js';

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

export function gatherEvidence(ctx: EvidenceContext) {
  const at: BranchContext = { projectDir: ctx.projectDir, now: () => new Date() };
  const options = ctx.gh ?? {};
  return async (
    item: Candidate,
    config: ProjectConfig,
    main: MainMerges,
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
    const answers = parseAnswers(read('answers.md'));
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

    const work: Partial<Record<State, boolean>> = {
      triaged: !specComplete,
      'spec-approved': !planComplete,
      building: !tasksDone,
      verifying: review?.complete !== true,
      integrating: integrate === undefined,
    };
    // The session the dispatcher last issued has pushed nothing yet: do not start another.
    const pending =
      tip !== undefined && pendingManifest(at, tip)?.station === STATION_OF[item.state];
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
      ...(rg === undefined ? {} : { redGreen: rg }),
      ...(review === undefined ? {} : { verifyReport: review.checksPass }),
      ...(review === undefined ? {} : { findingsResolved: review.findingsResolved }),
      ...(ci === undefined ? {} : { requiredChecks: ci }),
      ...(security === undefined ? {} : { securityReport: checkSecurityReport(security).complete }),
      ...(failure === undefined ? {} : { failure }),
      needsSession: (work[item.state] ?? false) && !pending,
    };
  };
}
