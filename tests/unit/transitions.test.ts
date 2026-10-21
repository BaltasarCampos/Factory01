import { describe, expect, it } from 'vitest';
import type { FailureKind, Verdict } from '../../src/approvals/verify.js';
import {
  nextTransition,
  STATION_OF,
  type Evidence,
  type OwnerGate,
} from '../../src/dispatcher/transitions.js';
import type { ApprovalRecord, State, Station, Tier } from '../../src/model/types.js';

const HEAD = '1c9d0e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3';
const OLD_HEAD = '0b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7a8';
const BRANCH = 'claude/42-add-login';

const record = (gate: OwnerGate, extra: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  repo: 'baltisark/sample',
  issue: 42,
  gate,
  timestamp: '2026-10-01T09:12:44Z',
  nonce: '9f2c1e0a7b4d4e8f8a1b2c3d4e5f6a7b',
  ...extra,
});
const ok = (gate: OwnerGate, extra: Partial<ApprovalRecord> = {}): Verdict => ({
  ok: true,
  record: record(gate, extra),
  comment: { id: 'c1', createdAt: '2026-10-01T09:12:44Z', body: '' },
});
const no = (kind: FailureKind): Verdict => ({ ok: false, kind, reason: `${kind} for test` });
const approved = (tier: Tier = 2) => ok('approved', { tier, branch: BRANCH });
const specApproved = () =>
  ok('spec-approved', { tier: 2, branch: BRANCH, spec_sha: 'a'.repeat(40) });

const NONE: Evidence['owner'] = {
  approved: no('missing'),
  'spec-approved': no('missing'),
  waiver: no('missing'),
};
const base: Evidence = {
  rotationPending: false,
  historySigned: true,
  owner: NONE,
  intakeComplete: true,
};
/** Both Owner gates verify. */
const gated: Evidence = {
  ...base,
  owner: { ...NONE, approved: approved(), 'spec-approved': specApproved() },
};
/** Every required item job green at the branch head, or `states` for the named ones. */
const checks = (states: Record<string, string> = {}): NonNullable<Evidence['requiredChecks']> => ({
  head: HEAD,
  jobs: ['build-test', 'coverage', 'red-green', 'semgrep', 'gitleaks'].map((job) => ({
    job,
    state: states[job] ?? 'success',
  })),
});
const GREEN = checks();
/** Verify's evidence besides the review: green checks at the head, a clean security report. */
const verified: Evidence = {
  ...gated,
  branchHead: HEAD,
  requiredChecks: GREEN,
  securityReport: true,
};
const RUNNING = { line: false, stations: new Set<Station>() };
const paused = (...stations: Station[]) => ({ line: false, stations: new Set(stations) });

const next = (state: State, evidence: Evidence, pause = RUNNING, blockedFrom?: State) =>
  nextTransition(blockedFrom ? { state, blockedFrom } : { state }, evidence, pause);
const moves = (state: State, evidence: Evidence, to: State, pause = RUNNING) => {
  expect(next(state, evidence, pause)).toMatchObject({ ok: true, to });
};
const stays = (state: State, evidence: Evidence, pause = RUNNING) => {
  expect(next(state, evidence, pause).ok).toBe(false);
};

const ACTIVE: State[] = [
  'new',
  'triaged',
  'specified',
  'spec-approved',
  'planned',
  'building',
  'verifying',
  'integrating',
  'releasing',
];

describe('transition table rows (data-model.md § State machine)', () => {
  it('new → triaged only with a verifying owner:approved record carrying a tier', () => {
    moves('new', { ...base, owner: { ...NONE, approved: approved() } }, 'triaged');
    stays('new', base);
    stays('new', { ...base, owner: { ...NONE, approved: ok('approved', { branch: BRANCH }) } });
    stays('new', { ...base, owner: { ...NONE, approved: no('stale') } });
  });

  it('new → triaged waits until Intake’s output check passes (AC-009)', () => {
    const owned = { ...base, owner: { ...NONE, approved: approved() } };
    expect(next('new', { ...owned, intakeComplete: false })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Intake/) as string,
    });
    stays('new', { rotationPending: false, historySigned: true, owner: owned.owner });
  });

  it('new holds an item Intake marked a duplicate, though Intake is done; the hold is only in new (slice 24a-2)', () => {
    const owned = { ...base, owner: { ...NONE, approved: approved() } };
    expect(next('new', { ...owned, duplicateOf: 3 })).toEqual({
      ok: false,
      reason: 'marked a duplicate of #3; waits for the Owner',
    });
    moves('new', owned, 'triaged');
    moves('triaged', { ...gated, duplicateOf: 3, specComplete: true, draftPr: true }, 'specified');
  });

  it('new → triaged waits while a proposed tier: is above the confirmed tier (AC-009)', () => {
    const at = (proposedTier: Tier, confirmed: Tier = 2) => ({
      ...base,
      owner: { ...NONE, approved: approved(confirmed) },
      proposedTier,
    });
    expect(next('new', at(3))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(
        /tier:3 is above the confirmed tier 2.*approve --tier 3/,
      ) as string,
    });
    moves('new', at(2), 'triaged');
    moves('new', at(1), 'triaged');
    // A new `factory approve --tier 3` confirms the raise.
    moves('new', at(3, 3), 'triaged');
  });

  it('new → triaged never on another gate’s label (AC-069)', () => {
    stays('new', { ...base, owner: { ...NONE, 'spec-approved': specApproved() } });
    stays('new', { ...base, owner: { ...NONE, waiver: ok('waiver', { waives: 'gate:plan' }) } });
    // A verdict handed over for the wrong gate counts for neither.
    stays('new', { ...base, owner: { ...NONE, approved: ok('waiver', { tier: 2 }) } });
  });

  it('triaged → specified needs a complete spec.md and the draft PR (AC-010)', () => {
    const ready = { ...gated, specComplete: true, draftPr: true };
    moves('triaged', ready, 'specified');
    stays('triaged', { ...ready, specComplete: false });
    stays('triaged', { ...ready, draftPr: false });
  });

  it('specified → spec-approved on owner:spec-approved for the current spec.md (AC-010)', () => {
    moves('specified', gated, 'spec-approved');
    const owner = { ...gated.owner, 'spec-approved': no('stale') };
    expect(next('specified', { ...gated, owner })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('owner:spec-approved') as unknown,
    });
    stays('specified', { ...gated, owner: { ...gated.owner, 'spec-approved': no('missing') } });
    // A spec-approved verdict whose record is the approved record does not count.
    stays('specified', { ...gated, owner: { ...gated.owner, 'spec-approved': approved() } });
  });

  it('specified → spec-approved on an Owner-confirmed tier:1 without owner:spec-approved (AC-010)', () => {
    moves('specified', { ...base, owner: { ...NONE, approved: approved(1) } }, 'spec-approved');
  });

  it('an Intake-proposed tier:1 the Owner did not confirm still waits for owner:spec-approved (AC-069)', () => {
    // The Owner's approved record says tier 2; a tier:1 label is not an input at all.
    stays('specified', { ...base, owner: { ...NONE, approved: approved(2) } });
    stays('specified', base);
  });

  it('spec-approved → planned needs a complete plan and task list (AC-011)', () => {
    moves('spec-approved', { ...gated, planComplete: true }, 'planned');
    stays('spec-approved', gated);
  });

  it('planned → building always, once the Owner gates behind it hold', () => {
    moves('planned', gated, 'building');
  });

  it('building → verifying only on a green ci / red-green for the branch head (AC-012)', () => {
    const green = { head: HEAD, green: true };
    const ready = { ...gated, tasksDone: true, branchHead: HEAD, redGreen: green };
    moves('building', ready, 'verifying');
    stays('building', { ...ready, tasksDone: false });
    stays('building', { ...gated, tasksDone: true, branchHead: HEAD });
    stays('building', { ...ready, redGreen: { head: HEAD, green: false } });
    stays('building', { ...ready, redGreen: { head: OLD_HEAD, green: true } });
    stays('building', { ...gated, tasksDone: true, redGreen: green });
  });

  it('verifying → integrating needs a passing verify report and no open blocking finding', () => {
    const ready = { ...verified, verifyReport: true, findingsResolved: true };
    moves('verifying', ready, 'integrating');
    stays('verifying', { ...ready, verifyReport: false });
    stays('verifying', { ...ready, findingsResolved: false });
  });

  it('verifying → integrating needs every required job green at the branch head (T168)', () => {
    const ready = { ...verified, verifyReport: true, findingsResolved: true };
    const reviewed = { verifyReport: true, findingsResolved: true, securityReport: true };
    const none = { ...gated, branchHead: HEAD, ...reviewed };
    expect(next('verifying', none)).toMatchObject({ ok: false, reason: /no required check/ });
    const old = { ...ready, requiredChecks: { ...GREEN, head: OLD_HEAD } };
    expect(next('verifying', old)).toMatchObject({ ok: false, reason: /no required check/ });
    const unreadable = { ...GREEN, unreadable: 'the release pinned on main has no list' };
    expect(next('verifying', { ...ready, requiredChecks: unreadable })).toMatchObject({
      ok: false,
      reason: /unreadable: the release pinned on main has no list/,
    });
  });

  it('a red required job holds Verify with one info alert naming it, once the head has finished (T168)', () => {
    const ready = { ...verified, verifyReport: true, findingsResolved: true };
    const red = checks({ coverage: 'failure', semgrep: 'cancelled' });
    expect(next('verifying', { ...ready, requiredChecks: red })).toEqual({
      ok: false,
      reason: 'required checks red at 1c9d0e5f6a7b: coverage (failure), semgrep (cancelled)',
      alert: {
        urgency: 'info',
        kind: 'checks-red',
        text: 'required checks red at 1c9d0e5f6a7b: coverage (failure), semgrep (cancelled)',
      },
    });
    const stillRunning = checks({ coverage: 'failure', semgrep: 'pending' });
    const waiting = next('verifying', { ...ready, requiredChecks: stillRunning });
    expect(waiting).toMatchObject({ ok: false, reason: /red at 1c9d0e5f6a7b: coverage/ });
    expect(waiting).not.toHaveProperty('alert');
  });

  it('pending or missing required jobs wait silently (T168)', () => {
    const ready = { ...verified, verifyReport: true, findingsResolved: true };
    const running = checks({ 'red-green': 'pending', gitleaks: 'missing' });
    expect(next('verifying', { ...ready, requiredChecks: running })).toEqual({
      ok: false,
      reason:
        'required checks not finished at 1c9d0e5f6a7b: red-green (pending), gitleaks (missing)',
    });
  });

  it('a missing reports/security.md holds tier 2 and 3, never tier 1; a failing one holds any tier (T168)', () => {
    const reviewed = { verifyReport: true, findingsResolved: true };
    const noReport = { ...gated, branchHead: HEAD, requiredChecks: GREEN, ...reviewed };
    const at = (tier: Tier) => ({
      ...noReport,
      owner: { ...gated.owner, approved: approved(tier) },
    });
    moves('verifying', at(1), 'integrating');
    expect(next('verifying', at(2))).toMatchObject({ reason: /no reports\/security.md.*tier 2/ });
    expect(next('verifying', at(3))).toMatchObject({ reason: /no reports\/security.md.*tier 3/ });
    const open = { ...at(1), securityReport: false };
    expect(next('verifying', open)).toMatchObject({ reason: 'reports/security.md does not pass' });
  });

  it('integrating → releasing only on an Owner-signed merge of the checked head', () => {
    moves('integrating', { ...gated, ownerMerge: true }, 'releasing');
    stays('integrating', gated);
  });

  it('releasing → done needs a verified deploy-healthy record covering the merge (T160)', () => {
    const ready = { ...gated, ownerMerge: true, released: true };
    moves('releasing', ready, 'done');
    stays('releasing', { ...ready, released: false });
    stays('releasing', { ...gated, ownerMerge: true });
  });

  it('done and escalated are final for the dispatcher', () => {
    stays('done', { ...gated, ownerMerge: true, released: true, questionOpen: true });
    stays('escalated', { ...gated, owner: { ...gated.owner, waiver: no('tampering') } });
  });
});

describe('a state: label never stands in for an Owner gate', () => {
  const all = {
    ...gated,
    specComplete: true,
    draftPr: true,
    planComplete: true,
    tasksDone: true,
    branchHead: HEAD,
    redGreen: { head: HEAD, green: true },
    requiredChecks: GREEN,
    verifyReport: true,
    findingsResolved: true,
    securityReport: true,
    ownerMerge: true,
    released: true,
  };

  it('refuses every forward move past triaged without a verified owner:approved', () => {
    for (const state of ACTIVE.slice(1)) {
      const result = next(state, { ...all, owner: { ...gated.owner, approved: no('missing') } });
      expect(result, state).toMatchObject({
        ok: false,
        reason: expect.stringContaining('owner:approved') as unknown,
      });
    }
  });

  it('refuses every forward move past specified without the spec gate', () => {
    for (const state of ACTIVE.slice(3)) {
      const owner = { ...gated.owner, 'spec-approved': no('stale') };
      expect(next(state, { ...all, owner }).ok, state).toBe(false);
    }
  });

  it('refuses releasing → done when no Owner merge backs the releasing state', () => {
    stays('releasing', { ...all, ownerMerge: false });
  });
});

describe('global guards', () => {
  const tampered = { ...gated, owner: { ...gated.owner, approved: no('tampering') } };

  it('moves nothing, not even an escalation, while pause:line is in effect (AC-034)', () => {
    const line = { line: true, stations: new Set<Station>() };
    for (const state of ACTIVE) stays(state, { ...gated, planComplete: true }, line);
    stays('new', tampered, line);
  });

  it('only items entering a paused station wait (AC-034)', () => {
    stays('planned', gated, paused(4));
    moves(
      'building',
      { ...gated, tasksDone: true, branchHead: HEAD, redGreen: { head: HEAD, green: true } },
      'verifying',
      paused(4),
    );
    stays('new', { ...base, owner: { ...NONE, approved: approved() } }, paused(2));
    moves('planned', gated, 'building', paused(5));
  });

  it('moves nothing while main has a first-parent commit the Owner did not sign (AC-073, AC-087)', () => {
    const unsigned = { ...gated, historySigned: false, planComplete: true };
    expect(next('spec-approved', unsigned)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not signed') as unknown,
    });
    stays('new', { ...tampered, historySigned: false });
  });

  it('moves nothing and escalates nothing while a key rotation is pending', () => {
    stays('spec-approved', { ...gated, rotationPending: true, planComplete: true });
    stays('new', { ...tampered, rotationPending: true });
    const pending = { ...gated, owner: { ...gated.owner, waiver: no('rotation-pending') } };
    stays('planned', pending);
  });

  it('escalates any active item whose owner: label does not verify (AC-068)', () => {
    for (const state of [...ACTIVE, 'blocked' as const]) {
      for (const gate of ['approved', 'spec-approved', 'waiver'] as const) {
        for (const kind of ['tampering', 'replay'] as const) {
          const owner = { ...gated.owner, [gate]: no(kind) };
          expect(next(state, { ...gated, owner }), `${state} ${gate} ${kind}`).toMatchObject({
            ok: true,
            to: 'escalated',
            reason: expect.stringContaining(`owner:${gate}`) as unknown,
          });
        }
      }
    }
  });

  it('does not escalate a genuine record that went stale; it waits for a fresh signature', () => {
    const owner = { ...gated.owner, 'spec-approved': no('stale') };
    stays('specified', { ...gated, owner });
  });
});

describe('blocked', () => {
  it('any active state → blocked on an open question to the Owner', () => {
    for (const state of ACTIVE) moves(state, { ...gated, questionOpen: true }, 'blocked');
  });

  it('resumes to the state it left once the question is answered', () => {
    expect(next('blocked', gated, RUNNING, 'building')).toMatchObject({ ok: true, to: 'building' });
    expect(next('blocked', { ...gated, questionOpen: true }, RUNNING, 'building').ok).toBe(false);
    expect(next('blocked', gated, RUNNING).ok).toBe(false);
  });

  it('AC-033: tells the Owner what the question is, on blocking and while it stays open (T180)', () => {
    const asked = { ...gated, questionOpen: true, questionAlert: 'waits for your answers: Q1' };
    const alert = { urgency: 'info', kind: 'question', text: 'waits for your answers: Q1' };
    expect(next('triaged', asked)).toMatchObject({ ok: true, to: 'blocked', alert });
    expect(next('blocked', asked, RUNNING, 'triaged')).toMatchObject({ ok: false, alert });
    expect(next('blocked', gated, RUNNING, 'triaged').alert).toBeUndefined();
  });

  it('waits to resume into a paused station', () => {
    expect(next('blocked', gated, paused(4), 'building').ok).toBe(false);
  });

  it('does not resume into a state whose Owner gates no longer hold', () => {
    expect(next('blocked', base, RUNNING, 'building').ok).toBe(false);
    expect(next('blocked', gated, RUNNING, 'releasing').ok).toBe(false);
  });
});

describe('gate failure → earlier station', () => {
  it('returns the item to the state where the named station works', () => {
    const failure = (station: Station) => ({ ...gated, failure: { station, reason: 'tests' } });
    expect(next('verifying', failure(4))).toMatchObject({ ok: true, to: 'building' });
    expect(next('integrating', failure(4))).toMatchObject({ ok: true, to: 'building' });
    expect(next('building', failure(2))).toMatchObject({ ok: true, to: 'triaged' });
    expect(next('building', failure(3))).toMatchObject({ ok: true, to: 'spec-approved' });
  });

  it('refuses a failure report naming a station that is not earlier', () => {
    const failure = (station: Station) => ({ ...gated, failure: { station, reason: 'x' } });
    stays('building', failure(4));
    stays('building', failure(5));
    stays('building', failure(1));
  });

  it('waits when the station to return to is paused', () => {
    stays('verifying', { ...gated, failure: { station: 4, reason: 'tests' } }, paused(4));
  });

  it('maps every active state to the station that works on it', () => {
    expect(ACTIVE.map((s) => STATION_OF[s])).toEqual([1, 2, 2, 3, 3, 4, 5, 6, 7]);
  });
});
