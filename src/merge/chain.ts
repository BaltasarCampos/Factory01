// The approval chain of a work item, re-verified by `factory merge` at the checked head (T068,
// data-model § Pull request merge checks), and by `factory deploy` at the head each shipped
// merge checked, with the key lists at main's verified head (T069, slice 23c-1a): the `approved` record, `spec-approved` unless the
// verified tier is 1, and every waiver. Each record is verified with the key lists pinned at
// main's verified head and bound to this item through `verifyGate`: same repository and issue,
// the approved record's branch, and an `owner:` label added after its comment. A failure names
// the record. No two records in the chain share a nonce, and the laptop's ledger applies.
//
// A head-bound waiver (`gate:` code gate or `test:`) signed at another head is stale: it is not
// refused here but returned, so `merge` can offer to re-sign it at the checked head.
import { secondCopy } from '../approvals/keys.js';
import { NonceLedger, nonceLedgerPath } from '../approvals/nonces.js';
import { extractFromComment, headBound, parse } from '../approvals/record.js';
import {
  specBlobSha,
  verifyGate,
  verifySignature,
  type Expected,
  type LabelAdd,
  type PostedComment,
  type Verified,
} from '../approvals/verify.js';
import { RefusedError } from '../cli/env.js';
import { listComments } from '../github/comments.js';
import { timeline } from '../github/timeline.js';
import type { ApprovalRecord, Tier } from '../model/types.js';
import type { MergeContext } from './context.js';

export interface Chain {
  tier: Tier;
  /** The branch the verified `approved` record names: the PR's head branch. */
  branch: string;
  /** Head-bound waiver targets whose latest verified record covers another head. */
  stale: string[];
  /** Waiver targets whose latest verified record is in force at the checked head. */
  waivers: string[];
}

/** Records the comments hold, parsed whatever their signature; unparseable ones hold none. */
function recordsIn(comments: readonly PostedComment[]) {
  return comments.flatMap((comment) => {
    if (!comment.body.includes('```factory-record')) return [];
    try {
      const signed = extractFromComment(comment.body);
      return [{ comment, signed, record: parse(signed.text) }];
    } catch {
      return [];
    }
  });
}

/** What the chain needs: main's keys, and the head and branch the item was checked at. */
export type ChainContext = Pick<
  MergeContext,
  'config' | 'env' | 'keys' | 'home' | 'cwd' | 'branch' | 'head'
>;

/**
 * The item's chain, verified for `merge` before it merges, or for `deploy` before it ships the
 * merged item; the refusals say which command to run again.
 */
export async function verifyChain(
  c: ChainContext,
  issue: number,
  command: 'merge' | 'deploy' = 'merge',
): Promise<Chain> {
  const NOTHING = `nothing was ${command === 'merge' ? 'merged' : 'deployed'}`;
  const RUN_AGAIN = `and run ${command} again; ${NOTHING}`;
  const { repo } = c.config;
  const options = { env: c.env };
  const comments = await listComments(repo, issue, options);
  const events = await timeline(repo, issue, options);
  const labelAdds: LabelAdd[] = events.filter((e) => e.event === 'labeled');
  const held = recordsIn(comments);
  const base = { keys: c.keys, secondCopy: secondCopy(c.env, c.home), comments, labelAdds };

  /** Verify one gate (one waiver target), naming the record that fails. */
  const verify = (expected: Expected, matches: (r: ApprovalRecord) => boolean): Verified => {
    const verdict = verifyGate({ ...base, expected });
    if (verdict.ok) return verdict;
    const named = held.filter((h) => h.record.gate === expected.gate && matches(h.record)).at(-1);
    const target = expected.waives ? ` for ${expected.waives}` : '';
    // A record not signed by a listed key, or for another item, can grant nothing here.
    const groundless =
      named !== undefined &&
      (named.record.repo !== repo ||
        named.record.issue !== issue ||
        !verifySignature(named.signed, c.keys, c.env));
    if (groundless)
      throw new RefusedError(
        `#${String(issue)} has no verified owner:${expected.gate}${target}: ${verdict.reason}; comment ${named.comment.id} holds a record that does not verify and grants nothing; if you did not post it, delete it ${RUN_AGAIN}`,
      );
    const what = named
      ? `; see comment ${named.comment.id} (${named.record.gate} record for ${named.record.repo}#${String(named.record.issue)}, posted ${named.comment.createdAt})`
      : '';
    if (verdict.kind === 'stale' && expected.gate === 'spec-approved')
      throw new RefusedError(
        `spec.md changed since it was approved${what}; run factory approve ${String(issue)} spec`,
      );
    throw new RefusedError(
      `#${String(issue)} has no verified owner:${expected.gate}${target}: ${verdict.reason}${what}; ${NOTHING}`,
    );
  };
  const item = { repo, issue, branch: c.branch };

  const approved = verify({ ...item, gate: 'approved' }, () => true);
  const tier = approved.record.tier;
  if (tier === undefined) throw new RefusedError('malformed approval');
  const chain: Verified[] = [approved];
  const bound = { ...item, tier };

  if (tier !== 1) {
    let specSha: string;
    try {
      specSha = specBlobSha(c.cwd, c.head, `specs/${c.branch.slice('claude/'.length)}`);
    } catch (err) {
      throw new RefusedError(err instanceof Error ? err.message : String(err));
    }
    chain.push(verify({ ...bound, gate: 'spec-approved', specSha }, () => true));
  }

  // Every waiver target any record names for this item, whatever its signature.
  const targets = [
    ...new Set(
      held
        .filter((h) => h.record.gate === 'waiver' && h.record.repo === repo)
        .filter((h) => h.record.issue === issue)
        .map((h) => h.record.waives ?? ''),
    ),
  ];
  const waiverLabel = events.filter((e) => e.label === 'owner:waiver').at(-1);
  if (targets.length === 0 && waiverLabel?.event === 'labeled')
    throw new RefusedError(
      `owner:waiver is on #${String(issue)} with no waiver record behind it, so it grants nothing; if you did not add it, remove the label ${RUN_AGAIN}`,
    );
  const stale: string[] = [];
  for (const waives of targets) {
    const expected: Expected = { ...bound, gate: 'waiver', waives, head: c.head };
    const verdict = verifyGate({ ...base, expected });
    if (!verdict.ok && verdict.kind === 'stale' && headBound(waives)) stale.push(waives);
    else chain.push(verify(expected, (r) => r.waives === waives));
  }

  // One nonce, one record: across the gates too. Then the laptop's ledger.
  const seen = new Map<string, Verified>();
  for (const v of chain) {
    const earlier = seen.get(v.record.nonce);
    if (earlier !== undefined)
      throw new RefusedError(
        `records share nonce ${v.record.nonce}: comment ${earlier.comment.id} (${earlier.record.gate}) and comment ${v.comment.id} (${v.record.gate}); ${NOTHING}`,
      );
    seen.set(v.record.nonce, v);
  }
  const ledger = new NonceLedger(nonceLedgerPath(c.home));
  for (const v of chain)
    if (!ledger.claim(v.record.nonce, `${repo}#${String(issue)}/${v.comment.id}`))
      throw new RefusedError(
        `the ${v.record.gate} record in comment ${v.comment.id}: nonce ${v.record.nonce} was first seen on another comment (${ledger.path}); ${NOTHING}`,
      );
  const waivers = chain.flatMap((v) => (v.record.gate === 'waiver' ? [v.record.waives ?? ''] : []));
  return { tier, branch: c.branch, stale, waivers };
}
