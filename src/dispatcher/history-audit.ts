// The dispatcher's audit of main (FR-016g, AC-073, AC-087, AC-088). A first-parent commit the
// Owner did not sign (a GitHub merge button, a direct push) stops the line with an urgent
// tampering alert. An item branch on origin whose item main already merged was pushed again
// after `factory merge` deleted it, which is also tampering: it raises an alert, and the
// once-only rule keeps it from being merged a second time.
import { spawnSync } from 'node:child_process';
import { HistoryError } from '../git/history.js';
import type { MainMerges } from '../git/merges.js';

export interface HistoryAudit {
  /** Why main fails the signed-history rule, naming the first commit that is not signed. */
  unsigned?: string;
  /** Item branches on origin whose item has an Owner-signed `Factory-Merge: #<issue>`. */
  recreated: string[];
}

/** `claude/<issue>-<slug>` → issue. */
export const itemOf = (branch: string): number | undefined => {
  const issue = /^claude\/([1-9]\d*)-/.exec(branch)?.[1];
  return issue === undefined ? undefined : Number(issue);
};

export function auditMain(
  projectDir: string,
  mainRef: string,
  history: MainMerges,
  env?: NodeJS.ProcessEnv,
): HistoryAudit {
  const remote = mainRef.includes('/') ? mainRef.slice(0, mainRef.indexOf('/')) : 'origin';
  const listed = spawnSync('git', ['ls-remote', '--heads', remote], {
    cwd: projectDir,
    env,
    encoding: 'utf8',
  });
  if (listed.error !== undefined || listed.status !== 0)
    throw new HistoryError(`cannot list the branches of ${remote}: ${listed.stderr.trim()}`);
  const merged = new Set(
    history.merges.flatMap((m) => /^#([1-9]\d*)$/.exec(m.value)?.[1] ?? []).map(Number),
  );
  const recreated = listed.stdout
    .split('\n')
    .map((line) => line.split('\trefs/heads/')[1] ?? '')
    .filter((branch) => merged.has(itemOf(branch) ?? 0));
  return {
    ...(history.rejected === undefined
      ? {}
      : {
          unsigned: `main has a first-parent commit not signed by the Owner: ${history.rejected.reason}`,
        }),
    recreated,
  };
}
