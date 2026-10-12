// The laptop's own checks of a work item for `factory merge` (T068): weakened, ac-map and
// red-green, sandboxed (T164, always `{ sandbox: true }`, never reading `GITHUB_ACTIONS`) on the
// checked head against main's verified head, in one workspace with one install: the head runs
// once and all three read that run, then the base (weakened) and the base with the head's test
// code (red-green) run once each. The feature folder comes
// from the branch the verified `approved` record names; `featureDir` still refuses a
// `.specify/feature.json` naming another folder. A weakened finding counts as covered only by a
// `test:` waiver in force at the checked head; any finding covered by none refuses. No `gate:`
// waiver applies: this release signs none (`CODE_CHECKS` is empty, T167).
import { checkAcMap, type CheckedSet } from '../ci/ac-map.js';
import { redGreenIn, redGreenPlan, type RedGreen } from '../ci/red-green.js';
import { cleanPass, inWorkspace } from '../ci/vitest-run.js';
import { covers, weakenedIn, type WeakFinding } from '../ci/weakened.js';
import type { Output } from '../cli/commands.js';
import { RefusedError } from '../cli/env.js';
import { mergeBase } from '../git/diff.js';
import { visible } from '../notify/summary.js';
import { TEST_CONFIG } from '../stations/edges.js';
import type { Chain } from './chain.js';
import type { MergeContext } from './context.js';

export interface LaptopResults {
  /** Each weakened finding at the checked head, with the `test:` waiver covering it. */
  weakened: readonly { finding: WeakFinding; waiver: string | undefined }[];
  /** Titles of the head's tests that pass cleanly. */
  passing: readonly string[];
  redGreen: RedGreen;
}

const NOTHING = 'nothing was merged';
const isolation = { sandbox: true } as const;
const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

export function laptopChecks(
  c: MergeContext,
  chain: Chain,
  set: CheckedSet,
  out: Output,
): LaptopResults {
  const plan = redGreenPlan(c.cwd, c.main, c.head, {
    ...{ tier: chain.tier, branch: chain.branch, env: c.env },
  });
  const tests = chain.waivers.filter((w) => w.startsWith('test:'));
  // One workspace and install, and one run of the head that all three checks read.
  return inWorkspace(c.cwd, c.head, { isolation, config: TEST_CONFIG, env: c.env }, (ws) => {
    const headFiles = new Set(ws.write('head', c.head));
    const headRun = ws.test('head');

    const start = mergeBase(c.cwd, c.main, c.head, c.env);
    const weakened = weakenedIn(ws, start, headFiles, headRun).findings.map((finding) => ({
      finding,
      waiver: tests.find((w) => covers(w, finding)),
    }));
    const uncovered = weakened.filter((w) => w.waiver === undefined);
    if (uncovered.length > 0)
      throw new RefusedError(
        `weakened tests at ${c.head} with no test: waiver in force; ${NOTHING}:\n  ${uncovered
          .map((w) => `${visible(w.finding.target)}: ${w.finding.what}; covered by none`)
          .join('\n  ')}`,
      );
    out.write(
      weakened.length === 0
        ? 'weakened: no test weakened\n'
        : `weakened: ${plural(weakened.length, 'finding', 'findings')}, each covered by a test: waiver\n`,
    );

    const passing = headRun.tests.filter(cleanPass).map((t) => t.name);
    const unmapped = checkAcMap(set, passing);
    if (unmapped.length > 0)
      throw new RefusedError(`ac-map fails at ${c.head}; ${NOTHING}:\n  ${unmapped.join('\n  ')}`);
    out.write('ac-map: every checked criterion has a passing test\n');

    const rg = plan.done ?? redGreenIn(ws, plan, headRun);
    if (rg.skipped)
      out.write(`red-green skipped: only test code changed (${rg.files.join(', ')})\n`);
    else if (rg.findings.length > 0)
      throw new RefusedError(
        `red-green fails at ${c.head}; ${NOTHING}:\n  ${rg.findings.join('\n  ')}`,
      );
    else
      out.write(
        `red-green: ${plural(rg.checked, 'criterion goes', 'criteria go')} from failing to passing\n`,
      );
    return { weakened, passing, redGreen: rg };
  });
}
