// Release evidence for `releasing → done` (T160, slice 23d; design v1.8; Owner decisions
// 2026-10-14 and 2026-10-15). `factory deploy` signs `deployed` before anything runs and
// `deploy-healthy` only after its own health check passes, naming the first one's nonce; both are
// posted on the inbox issue. An item is released when such a pair verifies with main's pinned key
// lists, with the same head, and that head is the item's Owner-signed merge or comes after it on
// main's verified first-parent history. Release notes are not read again: the deploy refuses to
// sign `deployed` without rollback steps for every item it ships. A `deployed` record alone, a
// health summary or any unsigned comment moves nothing.
import type { ReleaseKeys } from '../approvals/keys.js';
import { firstUses } from '../approvals/nonces.js';
import { extractFromComment, parse } from '../approvals/record.js';
import { verifySignature, type PostedComment } from '../approvals/verify.js';
import type { MainMerges } from '../git/merges.js';
import type { ApprovalRecord } from '../model/types.js';

/** The heads of every verified `deployed` and `deploy-healthy` pair on the inbox issue. */
export function releasedHeads(
  comments: readonly PostedComment[],
  o: { keys: ReleaseKeys; repo: string; inboxIssue: number },
): Set<string> {
  const posted: { record: ApprovalRecord }[] = [];
  const byTime = [...comments].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const comment of byTime) {
    if (!comment.body.includes('```factory-record')) continue;
    try {
      const signed = extractFromComment(comment.body);
      const record = parse(signed.text);
      const deploy = record.gate === 'deployed' || record.gate === 'deploy-healthy';
      const ours = record.repo === o.repo && record.issue === o.inboxIssue;
      if (deploy && ours && verifySignature(signed, o.keys)) posted.push({ record });
    } catch {
      // Malformed or non-canonical: proves nothing.
    }
  }
  // Only the first occurrence of a nonce counts, on either side of a pair.
  const { first } = firstUses(posted);
  const deployed = new Map(
    first.filter((p) => p.record.gate === 'deployed').map((p) => [p.record.nonce, p.record.head]),
  );
  return new Set(
    first.flatMap(({ record }) =>
      record.gate === 'deploy-healthy' &&
      record.deployed !== undefined &&
      record.head !== undefined &&
      deployed.get(record.deployed) === record.head
        ? [record.head]
        : [],
    ),
  );
}

/** Whether a released head contains item `issue`'s merge, both on main's verified history. */
export function isReleased(
  heads: ReadonlySet<string>,
  main: Pick<MainMerges, 'merges' | 'commits'>,
  issue: number,
): boolean {
  const order = main.commits.map((c) => c.commit);
  const merge = main.merges.find((m) => m.value === `#${String(issue)}`);
  const at = merge === undefined ? -1 : order.indexOf(merge.commit);
  return at !== -1 && [...heads].some((head) => order.indexOf(head) >= at);
}
