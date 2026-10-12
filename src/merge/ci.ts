// CI on the checked head for `factory merge` (T068, Owner decisions 2026-10-12). The required jobs
// are data the release ships, `factory/profiles/<profile>/ci/required-checks.json`, read at main's
// pin; a contract test ties the list to the workflow templates, so no `if:` condition or path
// filter is interpreted here. Each job is bound to the workflow file it is installed at and read
// from GitHub Actions workflow runs for exactly the checked commit; commit statuses are never read,
// since anyone with write access, an agent included, can post one. For each required job the
// latest attempt in the latest run decides; earlier failed attempts are kept for the summary.
import { spawnSync } from 'node:child_process';
import { RefusedError } from '../cli/env.js';
import { gh, repoArg, type GhOptions } from '../github/gh.js';

export const BRANCH_KINDS = ['item', 'define', 'upgrade', 'log', 'factory-repository'] as const;
export type BranchKind = (typeof BRANCH_KINDS)[number];

export interface RequiredJob {
  /** The workflow template, under `factory/`. */
  workflow: string;
  /** Where the job runs from: `.github/workflows/<file>`. */
  installed: string;
  job: string;
  /** The job's `if:` in that workflow, checked by the contract test only. */
  if: string | null;
  kinds: BranchKind[];
  /** Required only when the pull request changes a file matching one; `**\/<file name>` only. */
  paths?: string[];
}

export interface RequiredChecks {
  jobs: RequiredJob[];
  exempt: { workflow: string; installed: string; job: string; why: string }[];
}

export interface JobResult {
  job: string;
  /** The workflow file the job was read from. */
  workflow: string;
  /** The latest run's conclusion, `pending` while it runs, `missing` when none ran. */
  state: string;
  /** Earlier attempts of the job in that workflow run that did not succeed. */
  failedBefore: number;
  /**
   * Earlier runs of the same workflow file at the same commit that did not succeed: a new run,
   * from closing and reopening the pull request, would otherwise hide them.
   */
  failedRuns: number;
}

const FILE = 'required-checks.json';
const INSTALLED = /^\.github\/workflows\/[\w.-]+\.ya?ml$/;
const BASENAME = /^\*\*\/([^/*?[\]{}!]+)$/;

/** Parse and check the list; anything unexpected refuses rather than requiring less. */
export function loadRequiredChecks(text: string): RequiredChecks {
  const refuse = (why: string) => new RefusedError(`${FILE}: ${why}`);
  let data: Partial<RequiredChecks>;
  try {
    data = JSON.parse(text) as Partial<RequiredChecks>;
  } catch {
    throw refuse('not JSON');
  }
  if (!Array.isArray(data.jobs) || !Array.isArray(data.exempt))
    throw refuse('needs jobs and exempt');
  for (const j of data.jobs) {
    if (typeof j.job !== 'string' || typeof j.workflow !== 'string')
      throw refuse('a job needs a name');
    if (typeof j.installed !== 'string' || !INSTALLED.test(j.installed))
      throw refuse(`${j.job}: installed must be .github/workflows/<file>`);
    if (!Array.isArray(j.kinds) || j.kinds.some((k) => !BRANCH_KINDS.includes(k)))
      throw refuse(`${j.job}: unknown branch kind`);
    if (j.paths !== undefined && !j.paths.every((p) => BASENAME.test(p)))
      throw refuse(`${j.job}: a path rule must be **/<file name>`);
  }
  return { jobs: data.jobs, exempt: data.exempt };
}

/** The list in the release pinned at `sha`, in the factory clone. */
export function requiredChecksAt(factory: string, sha: string, profile: string): RequiredChecks {
  const shown = spawnSync('git', ['show', `${sha}:factory/profiles/${profile}/ci/${FILE}`], {
    cwd: factory,
    encoding: 'utf8',
  });
  if (shown.status !== 0)
    throw new RefusedError(`the release pinned on main has no ${FILE}; nothing was merged`);
  return loadRequiredChecks(shown.stdout);
}

/** The jobs required for a branch kind, given the files the pull request changes. */
export function requiredJobs(
  list: RequiredChecks,
  kind: BranchKind,
  changed: readonly string[],
): RequiredJob[] {
  const touches = (pattern: string) => {
    const name = BASENAME.exec(pattern)?.[1];
    return changed.some((p) => p === name || p.endsWith(`/${name ?? ''}`));
  };
  return list.jobs.filter(
    (j) => j.kinds.includes(kind) && (j.paths === undefined || j.paths.some(touches)),
  );
}

interface WorkflowRun {
  id: number;
  path: string;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
}

interface Job {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
}

/** A page `gh api` returned, refused unless it holds every entry. */
async function page<T>(path: string, key: string, options: GhOptions): Promise<T[]> {
  const out = (await gh(['api', path], { ...options, json: true })) as Record<string, unknown>;
  const list = out[key];
  const entries = Array.isArray(list) ? (list as T[]) : [];
  if (typeof out.total_count !== 'number' || out.total_count > entries.length)
    throw new RefusedError(`cannot read every entry of ${path} in one page; nothing was merged`);
  return entries;
}

/**
 * Each required job's state at `sha`, read from the latest `pull_request` workflow run of the
 * workflow file it is installed at, and that run's jobs over all its attempts. Only GitHub Actions
 * creates workflow runs, so no other app can report one; a job of the same name in another
 * workflow file counts for nothing.
 */
export async function ciAt(
  repo: string,
  sha: string,
  jobs: readonly RequiredJob[],
  options: GhOptions,
): Promise<JobResult[]> {
  const base = `repos/${repoArg(repo)}/actions/runs`;
  const runs = (
    await page<WorkflowRun>(
      `${base}?head_sha=${sha}&event=pull_request&per_page=100`,
      'workflow_runs',
      options,
    )
  ).filter((r) => r.head_sha === sha && r.event === 'pull_request');
  const results: JobResult[] = [];
  for (const installed of new Set(jobs.map((j) => j.installed))) {
    const ofFile = runs.filter((r) => r.path === installed).sort((a, b) => a.id - b.id);
    const latest = ofFile.at(-1);
    const failedRuns = ofFile
      .slice(0, -1)
      .filter((r) => r.status === 'completed' && r.conclusion !== 'success').length;
    const ran =
      latest === undefined
        ? []
        : await page<Job>(
            `${base}/${String(latest.id)}/jobs?filter=all&per_page=100`,
            'jobs',
            options,
          );
    for (const { job } of jobs.filter((j) => j.installed === installed)) {
      const attempts = ran
        .filter((r) => r.name === job)
        .sort((a, b) => a.run_attempt - b.run_attempt || a.id - b.id);
      const last = attempts.at(-1);
      const state =
        last === undefined
          ? 'missing'
          : last.status !== 'completed'
            ? 'pending'
            : (last.conclusion ?? 'unknown');
      const failedBefore = attempts
        .slice(0, -1)
        .filter((r) => r.status === 'completed' && r.conclusion !== 'success').length;
      results.push({ job, workflow: installed, state, failedBefore, failedRuns });
    }
  }
  return results;
}
