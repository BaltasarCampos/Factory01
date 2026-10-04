// Pause state (data-model.md § Pause state, FR-029, FR-029a). Derived, never stored:
//
//   paused(scope) = ∃ labeled(pause:scope) at t1
//                   ∧ ¬∃ valid resume record r for scope with r.timestamp > t1
//
// Anyone may add a `pause:` label and it pauses; removing the label never unpauses. Only an
// Owner-signed resume record, at the first use of its nonce, lifts pauses added before its
// signed timestamp.
import { checkSecondCopy, type ReleaseKeys } from '../approvals/keys.js';
import { firstUses } from '../approvals/nonces.js';
import { extractFromComment, parse } from '../approvals/record.js';
import { verifySignature, type PostedComment } from '../approvals/verify.js';
import { STATIONS, type ApprovalRecord, type Station } from '../model/types.js';

/** A `labeled` / `unlabeled` event from the inbox issue timeline. */
export interface LabelEvent {
  event: 'labeled' | 'unlabeled';
  label: string;
  createdAt: string;
  actor?: string;
}

/** A resume record from an inbox comment, in posting order. */
export interface ResumeEntry {
  record: ApprovalRecord;
  /** Steps 1–5 of contracts/approval-record.md passed. */
  verified: boolean;
}

export interface PauseState {
  line: boolean;
  stations: Set<Station>;
  /** `pause:` labels in effect but absent: re-apply them and alert the Owner (AC-076). */
  missingLabels: string[];
}

const SCOPES = ['line', ...STATIONS] as const;
const time = (iso: string) => Date.parse(iso);

export function derivePause(
  timeline: readonly LabelEvent[],
  resumeRecords: readonly ResumeEntry[],
): PauseState {
  const resumes = firstUses(
    resumeRecords.filter((r) => r.verified && r.record.gate === 'resume'),
  ).first.map((r) => r.record);

  const state: PauseState = { line: false, stations: new Set(), missingLabels: [] };
  for (const scope of SCOPES) {
    const label = `pause:${scope}`;
    const events = timeline.filter((e) => e.label === label);
    const lifted = (t1: number) => resumes.some((r) => r.scope === scope && time(r.timestamp) > t1);
    const paused = events.some((e) => e.event === 'labeled' && !lifted(time(e.createdAt)));
    if (!paused) continue;
    if (scope === 'line') state.line = true;
    else state.stations.add(STATIONS.indexOf(scope) as Station);
    if (events.at(-1)?.event === 'unlabeled') state.missingLabels.push(label);
  }
  return state;
}

export interface ResumeContext {
  /** Main's pinned key lists. */
  keys: ReleaseKeys;
  secondCopy: string | undefined;
  previousNewest?: string;
  repo: string;
  inboxIssue: number;
}

/**
 * Resume records among the inbox comments, oldest first. A record verifies when the key lists
 * pass the two-copy check, it names this repo and inbox issue, and its signature verifies.
 * Comments without a well-formed record are left out.
 */
export function resumeEntries(
  comments: readonly PostedComment[],
  ctx: ResumeContext,
): ResumeEntry[] {
  const keysOk = checkSecondCopy(ctx.keys, ctx.secondCopy, ctx.previousNewest).status === 'ok';
  const out: ResumeEntry[] = [];
  const sorted = [...comments].sort((a, b) => time(a.createdAt) - time(b.createdAt));
  for (const comment of sorted) {
    if (!comment.body.includes('```factory-record')) continue;
    let signed;
    let record;
    try {
      signed = extractFromComment(comment.body);
      record = parse(signed.text);
    } catch {
      continue;
    }
    if (record.gate !== 'resume') continue;
    const verified =
      keysOk &&
      record.repo === ctx.repo &&
      record.issue === ctx.inboxIssue &&
      verifySignature(signed, ctx.keys);
    out.push({ record, verified });
  }
  return out;
}
