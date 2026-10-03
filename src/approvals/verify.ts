// Record verification shared by the dispatcher and the laptop commands
// (contracts/approval-record.md steps 1–6).
//
// A failure says what kind it is: `tampering` stops the item with an urgent alert; `replay`
// is a reused nonce; `stale` is a genuine record that no longer covers the item (spec.md or
// the PR head changed) and waits for a fresh signature; `rotation-pending` halts everything
// until the Owner finishes a key rotation; `missing` means the Owner has not approved yet.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalGate, ApprovalRecord, StationName, Tier } from '../model/types.js';
import { checkSecondCopy, type ReleaseKeys } from './keys.js';
import { firstUses, type NonceLedger } from './nonces.js';
import { extractFromComment, isCodeGateWaiver, parse, type SignedText } from './record.js';
import { RECORD_NAMESPACE } from './sign.js';

export type FailureKind = 'missing' | 'tampering' | 'replay' | 'stale' | 'rotation-pending';
export interface Failure {
  ok: false;
  kind: FailureKind;
  reason: string;
}
export interface Verified {
  ok: true;
  record: ApprovalRecord;
  comment: PostedComment;
}
export type Verdict = Verified | Failure;

/** The item as the verifier sees it; the record must match it, not the other way round. */
export interface Expected {
  repo: string;
  issue: number;
  gate: ApprovalGate;
  tier?: Tier;
  branch?: string;
  scope?: 'line' | StationName;
  waives?: string;
  /** Current `spec.md` blob; required for `spec-approved`. */
  specSha?: string;
  /** Current PR head (code-gate waivers) or the main commit deployed; ignored otherwise. */
  head?: string;
}

/** An issue comment, any author. */
export interface PostedComment {
  id: string;
  createdAt: string;
  body: string;
}

/** A `labeled` event from the issue timeline. */
export interface LabelAdd {
  label: string;
  createdAt: string;
}

export interface GateCheck {
  /** Main's pinned key lists. */
  keys: ReleaseKeys;
  secondCopy: string | undefined;
  previousNewest?: string;
  expected: Expected;
  comments: readonly PostedComment[];
  labelAdds: readonly LabelAdd[];
  /** Laptop commands only. */
  ledger?: NonceLedger;
}

const fail = (kind: FailureKind, reason: string): Failure => ({ ok: false, kind, reason });
const time = (iso: string) => Date.parse(iso);

/** Step 4: `ssh-keygen -Y verify` over the record bytes, decided by exit code only. */
export function verifySignature(
  signed: SignedText,
  keys: ReleaseKeys,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'factory-verify-'));
  try {
    const sig = join(dir, 'record.sig');
    writeFileSync(sig, signed.signature);
    const args = ['-Y', 'verify', '-n', RECORD_NAMESPACE, '-I', 'owner'];
    args.push('-f', keys.allowedSigners, '-r', keys.revokedKeys, '-s', sig);
    const result = spawnSync('ssh-keygen', args, {
      input: signed.text,
      env,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    return result.error === undefined && result.status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Step 5: a record's fields against the item; undefined when they match. */
export function matchFields(record: ApprovalRecord, expected: Expected): Failure | undefined {
  const identity = ['repo', 'issue', 'gate', 'tier', 'branch', 'scope', 'waives'] as const;
  for (const field of identity) {
    const want = expected[field];
    if (want !== undefined && record[field] !== want)
      return fail(
        'tampering',
        `record ${field} ${String(record[field])} does not match ${String(want)}`,
      );
  }
  const waives = record.waives ?? '';
  const upgrade = /^check:guardrail-change@(v\d+\.\d+\.\d+)@/.exec(waives)?.[1];
  if (upgrade !== undefined && expected.branch !== `factory/upgrade-${upgrade}`)
    return fail('tampering', `waiver for ${upgrade} used outside the upgrade PR for that release`);

  if (record.gate === 'spec-approved') {
    if (expected.specSha === undefined) throw new Error('spec-approved needs the current spec.md');
    if (record.spec_sha !== expected.specSha)
      return fail('stale', 'spec.md changed since it was approved');
  }
  const codeGate = record.gate === 'waiver' && isCodeGateWaiver(waives);
  if (codeGate || record.gate === 'deployed') {
    if (expected.head === undefined) throw new Error(`${record.gate} needs the head it covers`);
    if (record.head !== expected.head)
      return fail(
        codeGate ? 'stale' : 'tampering',
        `record head ${String(record.head)} is not ${expected.head}`,
      );
  }
  if (record.gate === 'waiver' && expected.waives === undefined)
    throw new Error('a waiver check needs the waiver target');
  return undefined;
}

/** `spec.md` blob on a branch, the value a spec approval binds (research R4). */
export function specBlobSha(repo: string, branch: string, featureDir: string): string {
  const path = `${featureDir.replace(/\/?$/, '/')}spec.md`;
  const result = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', `${branch}:${path}`], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`no ${path} on ${branch}`);
  return result.stdout.trim();
}

interface Candidate {
  comment: PostedComment;
  record: ApprovalRecord;
}

/**
 * Verify an `owner:<gate>` label on one issue: the latest add of the label must be backed by a
 * record that verifies, and the record for `expected` (the latest one for a waiver target) must
 * back a label-add and match the item. A record backs only the first add of its label after
 * its comment, and only at the first occurrence of its nonce.
 */
export function verifyGate(check: GateCheck): Verdict {
  const { expected } = check;
  if (
    expected.gate !== 'approved' &&
    expected.gate !== 'spec-approved' &&
    expected.gate !== 'waiver'
  )
    throw new Error(`no owner: label for gate ${expected.gate}`);
  const label = `owner:${expected.gate}`;

  const keyCheck = checkSecondCopy(check.keys, check.secondCopy, check.previousNewest);
  if (keyCheck.status !== 'ok') return fail(keyCheck.status, keyCheck.reason);

  const byTime = <T extends { createdAt: string }>(a: T, b: T) =>
    time(a.createdAt) - time(b.createdAt);
  const valid: Candidate[] = [];
  for (const comment of [...check.comments].sort(byTime)) {
    if (!comment.body.includes('```factory-record')) continue;
    try {
      const signed = extractFromComment(comment.body);
      const record = parse(signed.text);
      const same = record.repo === expected.repo && record.issue === expected.issue;
      if (same && record.gate === expected.gate && verifySignature(signed, check.keys))
        valid.push({ comment, record });
    } catch {
      // Malformed or non-canonical: backs nothing.
    }
  }

  const adds = check.labelAdds.filter((a) => a.label === label).sort(byTime);
  const firstAddAfter = (c: Candidate) =>
    adds.findIndex((a) => time(a.createdAt) >= time(c.comment.createdAt));
  const { first, replays } = firstUses(valid);
  const backing = new Map<number, Candidate>();
  for (const candidate of first) {
    const i = firstAddAfter(candidate);
    if (i !== -1 && !backing.has(i)) backing.set(i, candidate);
  }

  const latest = adds.length - 1;
  if (latest === -1) return fail('missing', `no ${label} label`);
  if (!backing.has(latest)) {
    const replayed = replays.some((c) => firstAddAfter(c) === latest);
    return replayed
      ? fail('replay', `${label} added at ${adds[latest]?.createdAt ?? ''} by a reused nonce`)
      : fail(
          'tampering',
          `${label} added at ${adds[latest]?.createdAt ?? ''} without a matching record`,
        );
  }

  const target =
    expected.gate === 'waiver'
      ? [...backing.values()]
          .filter((c) => c.record.waives === expected.waives)
          .sort((a, b) => byTime(a.comment, b.comment))
          .at(-1)
      : backing.get(latest);
  if (target === undefined)
    return fail('missing', `no verified waiver for ${String(expected.waives)}`);

  const mismatch = matchFields(target.record, expected);
  if (mismatch) return mismatch;

  const ref = `${expected.repo}#${String(expected.issue)}/${target.comment.id}`;
  if (check.ledger && !check.ledger.claim(target.record.nonce, ref))
    return fail(
      'replay',
      `nonce ${target.record.nonce} was first seen on another comment (${check.ledger.path})`,
    );
  return { ok: true, record: target.record, comment: target.comment };
}
