// What the item's merge summary shows (T068, AC-094), from what `factory merge`'s checks already
// found at the checked head: nothing is run again. `edges.ts`'s early warning is computed here
// from the safe diff, for the summary only: a regex false positive must never block a merge, so
// only the sandboxed weakened run refuses. Quarantine issues are agent-writable, so every issue a
// quarantine names is passed through and shown as not verified, never as a reason a finding is fine.
import type { CheckedSet } from '../ci/ac-map.js';
import { fileAt, safeGit, type FileChange } from '../git/diff.js';
import type { MergeView } from '../notify/summary.js';
import { isTestFile, testHelpers, weakenedTests } from '../stations/edges.js';
import type { JobResult } from './ci.js';
import type { Chain } from './chain.js';
import type { MergeContext } from './context.js';
import type { LaptopResults } from './laptop.js';

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

/** The JavaScript and TypeScript files at `commit`, by path, for the helper analysis. */
function sourcesAt(c: MergeContext, commit: string): Map<string, string> {
  const listed = safeGit(c.cwd, ['ls-tree', '-r', '-z', commit], c.env).stdout.toString('utf8');
  const files = new Map<string, string>();
  for (const entry of listed.split('\0')) {
    const tab = entry.indexOf('\t');
    const path = entry.slice(tab + 1);
    const [mode = '', type = ''] = entry.slice(0, tab).split(' ');
    if (tab < 0 || type !== 'blob' || !mode.startsWith('1006') || !SOURCE.test(path)) continue;
    const text = fileAt(c.cwd, commit, path, c.env);
    if (text !== undefined) files.set(path, text.toString('utf8'));
  }
  return files;
}

/** Every issue a quarantine names counts as open here; the summary marks each one not verified. */
const EVERY_ISSUE: ReadonlySet<number> = { has: () => true } as unknown as ReadonlySet<number>;

/**
 * The waiver covering an early-warning line, by 21b's exact rule: one equal to the line's own
 * target, or to `test:<the line's own file>`; never a prefix, since a `#` may be part of a path.
 */
export const coveringWaiver = (
  waivers: readonly string[],
  line: { target: string; file: string },
): string | undefined =>
  waivers.find((w) => w === line.target) ?? waivers.find((w) => w === `test:${line.file}`);

export function mergeView(
  c: MergeContext,
  base: string,
  changes: readonly FileChange[],
  chain: Chain,
  set: CheckedSet,
  ci: readonly JobResult[],
  laptop: LaptopResults,
): MergeView {
  const waivers = new Set(chain.waivers);
  const early = weakenedTests(
    changes.map((f) => ({
      ...{ path: f.path, status: f.status },
      ...{ added: f.added.map((l) => l.text), removed: f.removed.map((l) => l.text) },
    })),
    {
      waivers,
      openIssues: EVERY_ISSUE,
      helpers: testHelpers(sourcesAt(c, base), sourcesAt(c, c.head)),
    },
  );
  const rg = laptop.redGreen;
  return {
    pr: { number: c.pr.number, title: c.pr.title },
    diffstat: changes.map((f) => ({
      ...{ path: f.path, status: f.status },
      ...{ added: f.added.length, removed: f.removed.length },
    })),
    testFiles: changes.filter((f) => isTestFile(f.path)).map((f) => f.path),
    early: {
      findings: early.findings.map((e) => ({
        ...{ message: e.message, target: e.target },
        waiver: coveringWaiver(chain.waivers, e),
      })),
      problems: early.problems,
      quarantines: early.quarantines,
    },
    weakened: laptop.weakened.map((w) => ({
      ...{ target: w.finding.target, what: w.finding.what },
      waiver: w.waiver,
    })),
    passing: laptop.passing,
    checked: [...set.ids].sort(),
    ci,
    redGreen: rg.skipped
      ? { skipped: true, files: rg.files }
      : { skipped: false, checked: rg.checked },
    waivers: chain.waivers,
  };
}
