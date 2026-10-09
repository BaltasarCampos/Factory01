// `factory ci red-green` (T140, contracts/ci-checks.md, FR-042, AC-012, AC-089): every checked
// acceptance criterion has a tagged test that fails at the merge base and passes at the head.
// The checked set is ac-map's (`--tier`, unverified, CI only). The head run is the head's tree;
// the base run is the merge base's sources with the head's test code laid over them, so a
// changed test's head version meets the base code. A tagged test is red at the base when it
// fails there or its file fails to load; it must then pass at the head, same file and title.
// A diff of test code only, besides the item's own feature folder, skips the check. CI reads no
// waivers: a finding names the waiver that would cover it, and `factory merge` decides.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeBase, resolveCommit, safeDiff } from '../git/diff.js';
import type { Tier } from '../model/types.js';
import { isTestCode, TEST_CONFIG, type TestConfig } from '../stations/edges.js';
import { checkedSet, featureDir, namesId, setFindings } from './ac-map.js';
import { linkInstall, runTests, writeTree, type TestRun } from './vitest-run.js';

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
    if (tagged.some((t) => t.status === 'passed' && atBase(t.file, t.name))) {
      seen += 1;
      continue;
    }
    findings.push(
      `${id}: no tagged test fails at the merge base and passes at the head; a refactor needs a gate:red-green waiver for ${headSha}${dropped}`,
    );
  }
  return { findings, seen };
}

export function redGreen(
  repo: string,
  base: string,
  head: string,
  options: {
    tier: Tier | undefined;
    branch: string;
    install: string;
    env: NodeJS.ProcessEnv;
    config?: TestConfig;
  },
): RedGreen {
  const { env } = options;
  const config = options.config ?? TEST_CONFIG;
  const to = resolveCommit(repo, head, env);
  const start = mergeBase(repo, base, to, env);
  const set = checkedSet(repo, base, to, options.tier, options.branch, env);
  const problems = setFindings(set);
  if (problems.length > 0)
    return { skipped: false, findings: problems, checked: set.ids.size, seen: 0 };

  const feature = featureDir(repo, to, options.branch, env);
  const own = (path: string) => path === '.specify/feature.json' || path.startsWith(`${feature}/`);
  const changed = safeDiff(repo, start, to, env).map((c) => c.path);
  if (changed.every((path) => own(path) || isTestCode(path, config)))
    return { skipped: true, files: changed };

  const work = mkdtempSync(join(tmpdir(), 'factory-red-green-'));
  try {
    const tree = (name: string) => join(work, name, 'tree');
    writeTree(repo, to, tree('head'), () => true, env);
    writeTree(repo, start, tree('base'), (p) => !isTestCode(p, config), env);
    writeTree(repo, to, tree('base'), (p) => isTestCode(p, config), env);
    for (const name of ['head', 'base']) linkInstall(tree(name), options.install);
    const headRun = runTests(tree('head'), join(work, 'head'), config, env);
    const baseRun = runTests(tree('base'), join(work, 'base'), config, env);
    const { findings, seen } = judge(set.ids, set.headIds, baseRun, headRun, to);
    return { skipped: false, findings, checked: set.ids.size, seen };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
