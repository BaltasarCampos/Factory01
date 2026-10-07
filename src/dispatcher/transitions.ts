// The transition table (data-model.md § State machine, FR-011): one pure decision per item, no
// I/O. The dispatcher gathers the evidence (T060) and applies the decision through `state:`
// labels. Its decisions are advisory; `factory merge` and `factory deploy` decide on the laptop.
//
// Checked against formal/Dispatcher.tla by tests/property/transitions.prop.test.ts.
import type { Verdict } from '../approvals/verify.js';
import type { PauseState } from '../pause/derive.js';
import {
  STATIONS,
  type ApprovalRecord,
  type State,
  type Station,
  type Tier,
} from '../model/types.js';

export type OwnerGate = 'approved' | 'spec-approved' | 'waiver';
const OWNER_GATES: readonly OwnerGate[] = ['approved', 'spec-approved', 'waiver'];

export interface ItemStatus {
  state: State;
  /** For `blocked`: the state it left, from the `state:` label history. */
  blockedFrom?: State;
}

/**
 * What the dispatcher found for one item. Station outputs left out count as absent, so missing
 * evidence never moves an item. There is deliberately no field for events or `state:` labels,
 * and `tier:` labels open no gate: a proposed tier can only hold an item.
 */
export interface Evidence {
  /** Key rotation pending (data-model.md § Keys and rotation): nothing moves. */
  rotationPending: boolean;
  /** Every first-parent commit on main after the baseline is Owner-signed. */
  historySigned: boolean;
  /** `verifyGate` verdicts per `owner:` gate; a gate without its label is `missing`. */
  owner: Record<OwnerGate, Verdict>;
  /** Intake's output check passes with the confirmed tier (src/stations/checks/intake.ts). */
  intakeComplete?: boolean;
  /** The highest `tier:` label on the issue; above the confirmed tier, it holds `new`. */
  proposedTier?: Tier;
  /** An agent's question to the Owner is open on the issue. */
  questionOpen?: boolean;
  /** A failed gate's report, naming the earliest station able to fix it. */
  failure?: { station: Station; reason: string };
  /** `spec.md` has problem, ACs, non-goals and affected areas. */
  specComplete?: boolean;
  draftPr?: boolean;
  /** `plan.md` and `tasks.md` pass the Plan output check. */
  planComplete?: boolean;
  tasksDone?: boolean;
  branchHead?: string;
  /** The `ci / red-green` check run, for the commit it ran on. */
  redGreen?: { head: string; green: boolean };
  /** `reports/verify.md` lists every check passing. */
  verifyReport?: boolean;
  findingsResolved?: boolean;
  /** Main has an Owner-signed merge commit of the item's checked head. */
  ownerMerge?: boolean;
  /** Release notes and rollback path are on `claude/factory-log`. */
  releaseNotes?: boolean;
  /** A verified `deployed` record covers the merge. */
  deployed?: boolean;
}

/** `alert`: the dispatcher tells the Owner, e.g. a gate failed after the Owner's merge. */
export type Decision =
  | { ok: true; to: State; reason: string; alert?: string }
  | { ok: false; reason: string; alert?: string };

/** The station that works on an item in each state; it is entered when the item arrives. */
export const STATION_OF: Readonly<Record<State, Station | undefined>> = {
  new: 1,
  triaged: 2,
  specified: 2,
  'spec-approved': 3,
  planned: 3,
  building: 4,
  verifying: 5,
  integrating: 6,
  releasing: 7,
  done: undefined,
  blocked: undefined,
  escalated: undefined,
};

/** Where an item goes back to when a gate failure names a station. */
const REDO_AT: Partial<Record<Station, State>> = {
  2: 'triaged',
  3: 'spec-approved',
  4: 'building',
  5: 'verifying',
  6: 'integrating',
};

const FORWARD: readonly State[] = [
  'new',
  'triaged',
  'specified',
  'spec-approved',
  'planned',
  'building',
  'verifying',
  'integrating',
  'releasing',
  'done',
];
const at = (state: State) => FORWARD.indexOf(state);
const move = (to: State, reason: string): Decision => ({ ok: true, to, reason });
const stay = (reason: string): Decision => ({ ok: false, reason });

/** The verified record behind `owner:<gate>`, only if it is a record for that gate. */
function ownerRecord(e: Evidence, gate: OwnerGate): ApprovalRecord | undefined {
  const verdict = e.owner[gate];
  return verdict.ok && verdict.record.gate === gate ? verdict.record : undefined;
}

const why = (e: Evidence, gate: OwnerGate) => {
  const verdict = e.owner[gate];
  return `owner:${gate} ${verdict.ok ? 'record is for another gate' : verdict.reason}`;
};

/** Why `owner:approved` does not hold, or undefined when it does (it must carry the tier). */
function approvedMissing(e: Evidence): string | undefined {
  const record = ownerRecord(e, 'approved');
  if (record === undefined) return why(e, 'approved');
  return record.tier === undefined ? 'owner:approved record has no tier' : undefined;
}

/** The spec gate: `owner:spec-approved` for the current spec, or an Owner-confirmed tier 1. */
function specMissing(e: Evidence): string | undefined {
  if (ownerRecord(e, 'spec-approved') !== undefined) return undefined;
  if (approvedMissing(e) === undefined && ownerRecord(e, 'approved')?.tier === 1) return undefined;
  return why(e, 'spec-approved');
}

/**
 * Owner evidence every item in `state` must have. A `state:` label is only the dispatcher's
 * bookkeeping, so a state past a gate never stands in for the gate itself.
 */
export function ownerBasisMissing(state: State, e: Evidence): string | undefined {
  const i = at(state);
  if (i >= at('triaged')) {
    const missing = approvedMissing(e);
    if (missing) return missing;
  }
  if (i >= at('spec-approved')) {
    const missing = specMissing(e);
    if (missing) return missing;
  }
  if (i >= at('releasing') && !e.ownerMerge) return 'no Owner-signed merge of the item on main';
  if (i >= at('done') && !e.deployed) return 'no Owner deploy of the merge';
  return undefined;
}

/**
 * The row of the table for an item in `state`. Rows that open an Owner gate (→ triaged,
 * → spec-approved, → releasing, → done) rely on the target's basis check in nextTransition.
 */
function forward(state: State, e: Evidence): Decision {
  switch (state) {
    case 'new': {
      // A raise waits for a new `factory approve --tier` (data-model § State machine).
      const confirmed = ownerRecord(e, 'approved')?.tier;
      const proposed = e.proposedTier;
      if (proposed !== undefined && confirmed !== undefined && proposed > confirmed)
        return stay(
          `tier:${String(proposed)} is above the confirmed tier ${String(confirmed)}; waits for factory approve --tier ${String(proposed)}`,
        );
      if (!e.intakeComplete) return stay("Intake's output check does not pass");
      return move('triaged', 'owner:approved verified, Intake done');
    }
    case 'triaged':
      if (!e.specComplete) return stay('spec.md is not complete');
      return e.draftPr ? move('specified', 'spec.md complete, draft PR open') : stay('no draft PR');
    case 'specified':
      return move('spec-approved', 'spec approved by the Owner');
    case 'spec-approved':
      return e.planComplete ? move('planned', 'plan and tasks complete') : stay('plan incomplete');
    case 'planned':
      return move('building', 'next task assigned');
    case 'building': {
      if (!e.tasksDone) return stay('tasks not done');
      const rg = e.redGreen;
      if (rg === undefined || e.branchHead === undefined || rg.head !== e.branchHead)
        return stay('no ci / red-green result for the branch head');
      return rg.green ? move('verifying', 'ci / red-green green') : stay('ci / red-green failed');
    }
    case 'verifying':
      if (!e.verifyReport) return stay('reports/verify.md does not pass');
      return e.findingsResolved
        ? move('integrating', 'verify report passes')
        : stay('blocking review findings open');
    case 'integrating':
      return move('releasing', 'merged by the Owner');
    case 'releasing':
      return e.releaseNotes ? move('done', 'released and deployed') : stay('no release notes');
    default:
      return stay(`no forward row from state:${state}`);
  }
}

function decide(item: ItemStatus, e: Evidence): Decision {
  if (item.state === 'blocked') {
    if (e.questionOpen) return stay("waits for the Owner's answer");
    const back = item.blockedFrom;
    if (back === undefined || at(back) === -1 || back === 'done')
      return stay('blocked without the state it left');
    return move(back, 'question answered');
  }
  if (e.questionOpen) return move('blocked', 'question to the Owner');
  if (e.failure !== undefined && e.ownerMerge) {
    // Main is the item now (AC-058, FR-012): a later problem is new work, never a route back.
    const alert = `failed a gate after the Owner's merge: ${e.failure.reason}; file a follow-up issue`;
    return at(item.state) < at('releasing')
      ? { ok: true, to: 'releasing', reason: 'merged by the Owner; failure after the merge', alert }
      : { ok: false, reason: "failure after the Owner's merge", alert };
  }
  if (e.failure !== undefined) {
    const to = REDO_AT[e.failure.station];
    if (to === undefined || at(to) >= at(item.state))
      return stay(`failure report names ${STATIONS[e.failure.station]}, not an earlier station`);
    return move(to, `gate failed: ${e.failure.reason}`);
  }
  return forward(item.state, e);
}

export function nextTransition(
  item: ItemStatus,
  e: Evidence,
  pause: Pick<PauseState, 'line' | 'stations'>,
): Decision {
  const verdicts = OWNER_GATES.map((gate) => [gate, e.owner[gate]] as const);
  if (e.rotationPending || verdicts.some(([, v]) => !v.ok && v.kind === 'rotation-pending'))
    return stay('key rotation pending');
  if (!e.historySigned) return stay('main has a first-parent commit not signed by the Owner');
  if (pause.line) return stay('pause:line in effect');
  if (item.state === 'done' || item.state === 'escalated')
    return stay(`state:${item.state} is final for the dispatcher`);

  for (const [gate, v] of verdicts)
    if (!v.ok && (v.kind === 'tampering' || v.kind === 'replay'))
      return move('escalated', `owner:${gate} does not verify (${v.kind}): ${v.reason}`);

  // Every move except to `escalated` or `blocked` must land on a state whose Owner basis holds. The basis only grows
  // along the line, so this also stops a forged `state:` label past a gate, and a resume from
  // `blocked` to a state taken from forgeable label history.
  const decision = decide(item, e);
  if (!decision.ok || decision.to === 'blocked') return decision;
  const missing = ownerBasisMissing(decision.to, e);
  if (missing) return stay(`waits for ${missing} to enter state:${decision.to}`);
  const station = STATION_OF[decision.to];
  if (station !== undefined && station !== STATION_OF[item.state] && pause.stations.has(station))
    return stay(`pause:${STATIONS[station]} in effect; waits to enter`);
  return decision;
}
