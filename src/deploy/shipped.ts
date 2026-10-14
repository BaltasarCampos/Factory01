// What a deploy ships, and the re-verification of every item in it (T069, FR-016f, slice 23c-1a;
// Owner decisions 2026-10-14). Since the commit deployed last, read from `deploys.log`: main's
// verified first-parent commits, of any kind, so a `config set` alone is something to deploy;
// main being that commit refuses. Each item merged since then, a verified `Factory-Merge: #N`, has
// its chain verified again as `merge` verified it: at the head that merge checked, its second
// parent, with the branch its signed message names, but with the key lists at main's verified
// head, so a key revoked since the merge refuses the deploy. Define, upgrade and log merges have
// no chain.
import { RefusedError } from '../cli/env.js';
import { safeGit } from '../git/diff.js';
import { verifyChain } from '../merge/chain.js';
import type { MainContext } from '../merge/context.js';
import { NO_FORMAL } from '../notify/summary.js';

const NOTHING = 'nothing was deployed';

export interface ShippedItem {
  issue: number;
  /** The signed merge commit on main. */
  merge: string;
  /** The head that merge checked: the merge's second parent. */
  head: string;
  branch: string;
}

export interface Shipped {
  /** The commit deployed last; undefined before the first deploy. */
  since: string | undefined;
  /** Main's verified first-parent commits after it, oldest first. */
  commits: string[];
  items: ShippedItem[];
  /** The other `Factory-Merge:` values since then: `define`, `upgrade <tag>`, `factory-log`. */
  others: { commit: string; value: string }[];
}

/** The commits and merges after `since` on main's verified history. */
export function shippedSince(at: MainContext, since: string | undefined): Shipped {
  const all = at.commits.map((c) => c.commit);
  const from = since === undefined ? 0 : all.indexOf(since) + 1;
  if (since !== undefined && from === 0)
    throw new RefusedError(
      `the last deploy, ${since}, is not on main's verified first-parent history; ${NOTHING}`,
    );
  if (since === at.main)
    throw new RefusedError(
      `main is already deployed at ${since}: there is nothing new; ${NOTHING}`,
    );
  const commits = all.slice(from);
  const after = new Set(commits);
  const items: ShippedItem[] = [];
  const others: Shipped['others'] = [];
  for (const { commit, value } of at.merges.filter((m) => after.has(m.commit))) {
    const issue = /^#(\d+)$/.exec(value)?.[1];
    if (issue === undefined) {
      others.push({ commit, value });
      continue;
    }
    const head = at.commits.find((c) => c.commit === commit)?.parents[1];
    // Never the Owner's git config: a log.showSignature there, global or in the checkout, would
    // put signature lines before the subject.
    const subject = safeGit(
      at.cwd,
      ['-c', 'log.showSignature=false', 'log', '-1', '--format=%s', commit],
      at.env,
    ).stdout.toString();
    const branch = /^Merge #\d+ from (claude\/\S+)\n?$/.exec(subject)?.[1];
    if (head === undefined || branch === undefined)
      throw new RefusedError(
        `${commit} merges #${issue} but does not name the head and branch it checked; ${NOTHING}`,
      );
    items.push({ issue: Number(issue), merge: commit, head, branch });
  }
  return { since, commits, items, others };
}

/** Each shipped item's chain, verified again; the first that fails refuses, naming the item. */
export async function verifyShipped(at: MainContext, shipped: Shipped): Promise<void> {
  for (const item of shipped.items) {
    const context = { ...at, head: item.head, branch: item.branch };
    const named = `#${String(item.issue)} (merged in ${item.merge.slice(0, 12)})`;
    let tier: number;
    try {
      tier = (await verifyChain(context, item.issue, 'deploy')).tier;
    } catch (err) {
      if (!(err instanceof RefusedError)) throw err;
      throw new RefusedError(`the approvals of ${named} do not verify: ${err.message}`);
    }
    if (tier === 3) throw new RefusedError(`${NO_FORMAL}: ${named} is tier 3; ${NOTHING}`);
  }
}
