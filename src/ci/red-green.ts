// `factory ci red-green` (T140, contracts/ci-checks.md, FR-042, AC-012, AC-089): every checked
// acceptance criterion has a tagged test that fails at the merge base and passes at the head.
// The checked set is ac-map's (`--tier`, unverified, CI only). The head run is the head's tree;
// the base run is the merge base's sources with the head's test code laid over them, so a
// changed test's head version meets the base code. A tagged test is red at the base when it
// fails there or its file fails to load; it must then pass at the head, same file and title.
// A diff of test code only, besides the item's own feature folder, skips the check. CI reads no
// waivers: a finding names the waiver that would cover it, and `factory merge` decides.
import { mergeBase, resolveCommit, safeDiff } from '../git/diff.js';
import type { Tier } from '../model/types.js';
import { isTestCode, TEST_CONFIG, type TestConfig } from '../stations/edges.js';
import { checkedSet, featureDir, namesId, setFindings, type CheckedSet } from './ac-map.js';
import {
  cleanPass,
  inWorkspace,
  type Isolation,
  type TestRun,
  type Workspace,
} from './vitest-run.js';

export type RedGreen =
  | { skipped: true; files: string[] }
  | { skipped: false; findings: string[]; checked: number; seen: number };

/** Findings per checked criterion, from the two runs. */
export function judge(
  ids: ReadonlySet<string>,
  headIds: ReadonlySet<string>,
  base: TestRun,
  head: TestRun,
  headSha: string,
): { findings: string[]; seen: number } {
  const findings: string[] = [];
  let seen = 0;
  const atBase = (file: string, name: string) =>
    base.loadFailed.has(file) ||
    base.tests.some((t) => t.file === file && t.name === name && t.status === 'failed');
  for (const id of [...ids].sort()) {
    const dropped = headIds.has(id)
      ? ''
      : `; dropped from spec.md, a gate:ac-${id.slice(3)} waiver for ${headSha} removes it`;
    const tagged = head.tests.filter((t) => namesId(t.name, id));
    if (tagged.length === 0) {
      findings.push(`${id}: no test names it${dropped}`);
      continue;
    }
    // A pass in `fails` mode or after a retry is not green.
    if (tagged.some((t) => cleanPass(t) && atBase(t.file, t.name))) {
      seen += 1;
      continue;
    }
    findings.push(
      `${id}: no tagged test fails at the merge base and passes at the head; a refactor needs a gate:red-green waiver for ${headSha}${dropped}`,
    );
  }
  return { findings, seen };
}

export interface RedGreenOptions {
  tier: Tier | undefined;
  branch: string;
  env: NodeJS.ProcessEnv;
  config?: TestConfig;
}

/** The check without running tests: its result already, or what the two runs need. */
export type RedGreenPlan =
  | { done: RedGreen }
  | { done?: undefined; set: CheckedSet; start: string; to: string; config: TestConfig };

export function redGreenPlan(
  repo: string,
  base: string,
  head: string,
  options: RedGreenOptions,
): RedGreenPlan {
  const { env } = options;
  const config = options.config ?? TEST_CONFIG;
  const to = resolveCommit(repo, head, env);
  const start = mergeBase(repo, base, to, env);
  const set = checkedSet(repo, base, to, options.tier, options.branch, env);
  const problems = setFindings(set);
  if (problems.length > 0)
    return { done: { skipped: false, findings: problems, checked: set.ids.size, seen: 0 } };

  const feature = featureDir(options.branch);
  const own = (path: string) => path.startsWith(`${feature}/`);
  const changed = safeDiff(repo, start, to, env).map((c) => c.path);
  if (changed.every((path) => own(path) || isTestCode(path, config)))
    return { done: { skipped: true, files: changed } };
  return { set, start, to, config };
}

/**
 * The two runs in a workspace whose `head` tree holds the head and already ran as `headRun`, so
 * a caller running other checks on the same head runs it once (`factory merge`).
 */
export function redGreenIn(
  ws: Workspace,
  plan: Exclude<RedGreenPlan, { done: RedGreen }>,
  headRun: TestRun,
): RedGreen {
  const { set, start, to, config } = plan;
  ws.write('base-tests', start, (p) => !isTestCode(p, config));
  ws.write('base-tests', to, (p) => isTestCode(p, config));
  const { findings, seen } = judge(set.ids, set.headIds, ws.test('base-tests'), headRun, to);
  return { skipped: false, findings, checked: set.ids.size, seen };
}

export function redGreen(
  repo: string,
  base: string,
  head: string,
  options: RedGreenOptions & { isolation: Isolation },
): RedGreen {
  const plan = redGreenPlan(repo, base, head, options);
  if (plan.done !== undefined) return plan.done;
  const { env } = options;
  return inWorkspace(
    repo,
    plan.to,
    { isolation: options.isolation, config: plan.config, env },
    (ws) => {
      ws.write('head', plan.to);
      return redGreenIn(ws, plan, ws.test('head'));
    },
  );
}
