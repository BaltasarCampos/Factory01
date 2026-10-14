// `Factory-Merge:` trailers on main (design v1.8 § Merging and verification, AC-006). `factory
// merge` writes one into every signed merge commit (`#<issue>`, `define`, `upgrade <tag>`,
// `factory-log`); the brief rule and the once-only rule read only these.
//
// A trailer counts only on a first-parent commit after `baseline` that the signed-history walk
// (src/git/history.ts) verified as Owner-signed. Authorship never counts. The walk goes oldest
// first and stops at the first commit it rejects, since nothing after an unsigned commit can be
// trusted. It fails closed: when a key list cannot be read, or git or ssh-keygen cannot run, it
// throws instead of reporting no merges.
import { walkMain, type HistoryOptions, type KeysFor } from './history.js';

export interface MainMerges {
  /** The last first-parent commit verified as Owner-signed, with all before it since baseline. */
  lastVerified: string | undefined;
  /** The first commit the walk rejected, when one was. */
  rejected?: { commit: string; reason: string };
  /** `Factory-Merge:` values on verified merge commits, oldest first. */
  merges: { commit: string; value: string }[];
  /** Every verified first-parent commit after baseline, oldest first, with its parents. */
  commits: { commit: string; parents: string[] }[];
}

export function verifiedMerges(
  repo: string,
  keysFor: KeysFor,
  options: HistoryOptions = {},
): MainMerges {
  const walk = walkMain(repo, keysFor, options);
  const merges = walk.commits
    .filter((c) => c.parents.length >= 2)
    .flatMap(({ commit, trailers }) =>
      trailers
        .split('\n')
        .map((v) => v.trim())
        .filter((value) => value !== '')
        .map((value) => ({ commit, value })),
    );
  return {
    lastVerified: walk.lastVerified,
    ...(walk.rejected === undefined ? {} : { rejected: walk.rejected }),
    merges,
    commits: walk.commits.map(({ commit, parents }) => ({ commit, parents })),
  };
}

/** The brief rule: main has an Owner-signed `Factory-Merge: define`. */
export const briefMerged = (history: MainMerges): boolean =>
  history.merges.some((m) => m.value === 'define');
