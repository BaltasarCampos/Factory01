// Station evidence for the transition table (T060): what the item's station outputs, its pull
// request, CI and main's history show. Files are read from git objects on the item branch as
// origin has it (from main once the item is merged and its branch deleted), never from a work
// tree or from events: `ci / red-green` counts only as a check run on the head of the item's
// pull request, so forged `gate_result` lines move nothing (AC-012).
//
// Not yet gathered: release notes and the deploy record (stations 7–8) and open questions, so
// an item stays in `releasing`, and Release, Ops and blocked items start no session.
import { GhError, gh, repoArg, type GhOptions } from '../github/gh.js';
import { listPrs } from '../github/prs.js';
import type { MainMerges } from '../git/merges.js';
import type { ProjectConfig, State } from '../model/types.js';
import { checkIntakeIssue } from '../stations/checks/intake.js';
import { checkPlan } from '../stations/checks/plan.js';
import { checkSpec } from '../stations/checks/spec.js';
import { checkVerifyReport } from '../stations/checks/verify.js';
import { conflictFailure } from '../stations/edges.js';
import { featureOf, fetchBranch, git, type BranchContext } from './branch.js';
import type { Candidate, StationEvidence } from './dispatch.js';
import { pendingManifest } from './manifest.js';
import { STATION_OF } from './transitions.js';

export interface EvidenceContext {
  projectDir: string;
  mainRef?: string;
  gh?: GhOptions;
}

/** The `ci / red-green` job's check run on `sha`: undefined until it has completed. */
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
    (r) => r.name === 'red-green' && r.status === 'completed',
  );
  return run === undefined ? undefined : { head: sha, green: run.conclusion === 'success' };
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
      return { ownerMerge, intakeComplete: intake.complete, needsSession: !intake.complete };
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

    const spec = read('spec.md');
    const plan = read('plan.md');
    const tasks = read('tasks.md');
    const verify = read('reports/verify.md');
    const integrate = read('reports/integrate.md');
    const specComplete = spec !== undefined && checkSpec(spec).complete;
    const sizeLimit = config.size_limit_lines;
    const planComplete =
      spec !== undefined &&
      plan !== undefined &&
      tasks !== undefined &&
      checkPlan({ spec, plan, tasks, sizeLimit }).complete;
    const tasksDone =
      tasks !== undefined && /^\s*- \[[xX]\] T\d+/m.test(tasks) && !/^\s*- \[ \] T\d+/m.test(tasks);
    const report = verify === undefined ? undefined : checkVerifyReport(verify);
    const failure = integrate === undefined ? undefined : conflictFailure(integrate);
    const [pr] = await listPrs(config.repo, { state: 'open', head: item.branch }, options);
    const checked = tip !== undefined && pr?.headRefOid === tip;

    const work: Partial<Record<State, boolean>> = {
      triaged: !specComplete,
      'spec-approved': !planComplete,
      building: !tasksDone,
      verifying: report?.complete !== true,
      integrating: integrate === undefined,
    };
    // The session the dispatcher last issued has pushed nothing yet: do not start another.
    const pending =
      tip !== undefined && pendingManifest(at, tip)?.station === STATION_OF[item.state];
    const rg = checked ? await redGreen(config.repo, tip, options) : undefined;
    return {
      ownerMerge,
      specComplete,
      draftPr: pr !== undefined,
      planComplete,
      tasksDone,
      ...(spec === undefined ? {} : { specSha: git(at, ['rev-parse', `${ref}:${dir}/spec.md`]) }),
      ...(tip === undefined ? {} : { branchHead: tip }),
      ...(rg === undefined ? {} : { redGreen: rg }),
      ...(report === undefined ? {} : { verifyReport: report.checksPass }),
      ...(report === undefined ? {} : { findingsResolved: report.findingsResolved }),
      ...(failure === undefined ? {} : { failure }),
      needsSession: (work[item.state] ?? false) && !pending,
    };
  };
}
