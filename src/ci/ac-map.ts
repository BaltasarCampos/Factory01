// `factory ci ac-map` (contracts/ci-checks.md, QG-2, FR-042, AC-097): every checked acceptance
// criterion has a passing test whose title names it. In CI the checked set follows the
// unverified `--tier` from the issue's label (Owner decision 2026-10-08): tier 1, or none, is
// every ID ever in `spec.md` on the branch, so deleting a criterion does not drop it; tier 2–3 is
// the IDs in `spec.md` at the head. `factory merge` applies the exact rule with the verified
// tier and record.
import { RefusedError } from '../cli/env.js';
import { fileAt, mergeBase, resolveCommit, safeGit } from '../git/diff.js';
import { criterionLines } from '../stations/checks/spec.js';
import type { Tier } from '../model/types.js';

const AC_ID = /\bAC-\d+\b/g;

const ITEM_BRANCH = /^claude\/(\d+-[a-z0-9-]+)$/;

/**
 * The item's feature folder: `specs/<issue>-<slug>` for the branch `claude/<issue>-<slug>`, and
 * `.specify/feature.json` at `commit` must name exactly that. Otherwise a branch could point the
 * checks at another feature's criteria, or at a new trivial spec.
 */
export function featureDir(
  repo: string,
  commit: string,
  branch: string,
  env: NodeJS.ProcessEnv,
): string {
  const item = ITEM_BRANCH.exec(branch)?.[1];
  if (item === undefined)
    throw new RefusedError(`${branch} is not a work-item branch (claude/<issue>-<slug>)`);
  const bytes = fileAt(repo, commit, '.specify/feature.json', env);
  if (bytes === undefined) throw new RefusedError('no .specify/feature.json at the head');
  const dir = (JSON.parse(bytes.toString('utf8')) as { feature_directory?: unknown })
    .feature_directory;
  if (typeof dir !== 'string' || !/^specs\/[^/]+$/.test(dir))
    throw new RefusedError('.specify/feature.json: feature_directory must be specs/<feature>');
  if (dir !== `specs/${item}`)
    throw new RefusedError(
      `.specify/feature.json names ${dir}, but the branch ${branch} is the feature specs/${item}`,
    );
  return dir;
}

export interface CheckedSet {
  ids: Set<string>;
  /** The IDs in `spec.md` at the head; at tier 1 `ids` may hold more. */
  headIds: Set<string>;
  /** Criterion lines at the head without exactly one leading ID. */
  problems: string[];
}

export function checkedSet(
  repo: string,
  base: string,
  head: string,
  tier: Tier | undefined,
  branch: string,
  env: NodeJS.ProcessEnv = process.env,
): CheckedSet {
  const to = resolveCommit(repo, head, env);
  const spec = `${featureDir(repo, to, branch, env)}/spec.md`;
  const text = fileAt(repo, to, spec, env)?.toString('utf8');
  if (text === undefined) throw new RefusedError(`no ${spec} at the head`);
  const lines = criterionLines(text);
  const headIds = new Set(lines.flatMap((l) => (l.id === undefined ? [] : [l.id])));
  const ids = new Set(headIds);
  const problems = lines.flatMap((l) =>
    l.problem === undefined ? [] : [`spec.md:${String(l.line)}: ${l.problem}`],
  );
  if (tier === undefined || tier === 1) {
    const commits = safeGit(repo, ['rev-list', `${mergeBase(repo, base, to, env)}..${to}`], env);
    if (commits.status !== 0) throw new RefusedError(`cannot list the branch's commits`);
    for (const commit of commits.stdout.toString().split('\n').filter(Boolean)) {
      const old = fileAt(repo, commit, spec, env)?.toString('utf8');
      for (const line of old === undefined ? [] : criterionLines(old))
        if (line.id !== undefined) ids.add(line.id);
    }
  }
  return { ids, headIds, problems };
}

type TestResult = {
  fullName?: unknown;
  title?: unknown;
  ancestorTitles?: unknown;
  status?: unknown;
};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

/** Titles of the passing tests in Vitest's JSON report. */
export function passingTitles(json: string): string[] {
  const report = JSON.parse(json) as { testResults?: unknown };
  if (!Array.isArray(report.testResults)) throw new RefusedError('not a Vitest JSON report');
  return list(report.testResults).flatMap((file) =>
    list((file as { assertionResults?: unknown }).assertionResults).flatMap((entry) => {
      const t = entry as TestResult;
      if (t.status !== 'passed') return [];
      if (typeof t.fullName === 'string') return [t.fullName];
      return [[...list(t.ancestorTitles), t.title].map(String).join(' ')];
    }),
  );
}

/** Whether a test title names `id` exactly: `AC-01` is not named by a title with `AC-010`. */
export const namesId = (title: string, id: string) =>
  [...title.matchAll(AC_ID)].some(([found]) => found === id);

/** The checked-set findings red-green and ac-map share: problems, and an empty set. */
export const setFindings = (set: CheckedSet) => [
  ...set.problems,
  ...(set.ids.size === 0 ? ['no acceptance criteria to check'] : []),
];

export function checkAcMap(set: CheckedSet, titles: readonly string[]): string[] {
  const named = new Set(titles.flatMap((t) => t.match(AC_ID) ?? []));
  return [
    ...setFindings(set),
    ...[...set.ids]
      .sort()
      .flatMap((id) => (named.has(id) ? [] : [`${id}: no passing test names it`])),
  ];
}
