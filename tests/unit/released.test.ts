// Release evidence for `releasing → done` (T160, slice 23d; Owner decisions 2026-10-14 and
// 2026-10-15): a verified `deploy-healthy` record naming a verified `deployed` record with the
// same head, that head on main's verified first-parent history at or after the item's merge.
import { beforeAll, describe, expect, it } from 'vitest';
import type { ReleaseKeys } from '../../src/approvals/keys.js';
import { newNonce, renderComment } from '../../src/approvals/record.js';
import { sign } from '../../src/approvals/sign.js';
import type { PostedComment } from '../../src/approvals/verify.js';
import { isReleased, releasedHeads } from '../../src/dispatcher/released.js';
import type { ApprovalRecord } from '../../src/model/types.js';
import { makeKeys, makeOtherKeys, writeKeyFiles, type TestKeys } from '../helpers/keys.js';

const REPO = 'owner/project';
const INBOX = 1;
const [BRIEF, MERGE, LATER, ELSEWHERE] = ['1', '2', '3', '4'].map((c) => c.repeat(40)) as [
  string,
  string,
  string,
  string,
];
/** Main's verified first-parent history: the brief, item #7's merge, then one more commit. */
const MAIN = {
  merges: [
    { commit: BRIEF, value: 'define' },
    { commit: MERGE, value: '#7' },
  ],
  commits: [BRIEF, MERGE, LATER].map((commit) => ({ commit, parents: [] })),
};

let owner: TestKeys;
let other: TestKeys;
let keys: ReleaseKeys;
beforeAll(() => {
  owner = makeKeys();
  other = makeOtherKeys();
  keys = writeKeyFiles([owner]);
});

let ids = 0;
const post = (record: ApprovalRecord, key = owner): PostedComment => ({
  id: String(++ids),
  createdAt: `2026-10-15T10:${String(ids % 60).padStart(2, '0')}:00Z`,
  body: renderComment(record, sign(record, key.privateKey, { stdinIsTTY: true })),
});
const base = { repo: REPO, issue: INBOX, timestamp: '2026-10-15T10:00:00Z' };
const deployed = (head: string, nonce = newNonce()): ApprovalRecord => ({
  ...base,
  gate: 'deployed',
  head,
  nonce,
});
const healthy = (of: ApprovalRecord, head = of.head ?? ''): ApprovalRecord => ({
  ...base,
  gate: 'deploy-healthy',
  head,
  deployed: of.nonce,
  nonce: newNonce(),
});
const heads = (comments: PostedComment[]) =>
  releasedHeads(comments, { keys, repo: REPO, inboxIssue: INBOX });

describe('release evidence (T160, slice 23d)', () => {
  it('a deploy-healthy record naming a deployed record with the same head releases every item merged at or before it', () => {
    const at = deployed(LATER);
    const released = heads([post(at), post(healthy(at))]);

    expect([...released]).toEqual([LATER]);
    expect(isReleased(released, MAIN, 7)).toBe(true);
    const atMerge = deployed(MERGE);
    expect(isReleased(heads([post(atMerge), post(healthy(atMerge))]), MAIN, 7)).toBe(true);
  });

  it('a deploy before the item was merged does not release it, nor one never merged', () => {
    const before = deployed(BRIEF);
    const released = heads([post(before), post(healthy(before))]);

    expect(isReleased(released, MAIN, 7)).toBe(false);
    const at = deployed(LATER);
    expect(isReleased(heads([post(at), post(healthy(at))]), MAIN, 8)).toBe(false);
  });

  it('a deployed record alone is never release evidence (AC-060)', () => {
    expect(heads([post(deployed(LATER))])).toEqual(new Set());
  });

  it('counts nothing that does not pair: another head, an unknown nonce, a head off main', () => {
    const at = deployed(LATER);
    expect(heads([post(at), post(healthy(at, MERGE))])).toEqual(new Set());
    expect(heads([post(healthy(at))])).toEqual(new Set());
    const off = deployed(ELSEWHERE);
    expect(isReleased(heads([post(off), post(healthy(off))]), MAIN, 7)).toBe(false);
  });

  it('counts no record signed by a key the pinned release does not list, on either side', () => {
    const at = deployed(LATER);
    expect(heads([post(at, other), post(healthy(at))])).toEqual(new Set());
    expect(heads([post(at), post(healthy(at), other)])).toEqual(new Set());
  });

  it('counts no record for another repository or issue, nor a malformed or edited one', () => {
    const at = deployed(LATER);
    const forOther = { ...healthy(at), repo: 'owner/other' };
    expect(heads([post(at), post(forOther)])).toEqual(new Set());
    const onItem = { ...healthy(at), issue: 7 };
    expect(heads([post(at), post(onItem)])).toEqual(new Set());
    const good = post(healthy(at));
    const edited = { ...good, body: good.body.replace(`head: ${LATER}`, `head: ${MERGE}`) };
    expect(heads([post(at), edited])).toEqual(new Set());
  });

  it('only the first occurrence of a nonce counts: a later deployed record reusing it pairs with nothing', () => {
    const first = deployed(MERGE);
    const reused = deployed(LATER, first.nonce);

    expect(heads([post(first), post(reused), post(healthy(reused))])).toEqual(new Set());
  });
});
