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
const base: Evidence = { rotationPending: false, historySigned: true, owner: NONE };
/** Both Owner gates verify. */
const gated: Evidence = {
  ...base,
  owner: { ...NONE, approved: approved(), 'spec-approved': specApproved() },
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
    const ready = { ...gated, verifyReport: true, findingsResolved: true };
    moves('verifying', ready, 'integrating');
    stays('verifying', { ...ready, verifyReport: false });
    stays('verifying', { ...ready, findingsResolved: false });
  });

  it('integrating → releasing only on an Owner-signed merge of the checked head', () => {
    moves('integrating', { ...gated, ownerMerge: true }, 'releasing');
    stays('integrating', gated);
  });

  it('releasing → done needs release notes and an Owner deploy', () => {
    const ready = { ...gated, ownerMerge: true, releaseNotes: true, deployed: true };
    moves('releasing', ready, 'done');
    stays('releasing', { ...ready, deployed: false });
    stays('releasing', { ...ready, releaseNotes: false });
  });

  it('done and escalated are final for the dispatcher', () => {
    stays('done', { ...gated, ownerMerge: true, deployed: true, questionOpen: true });
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
    verifyReport: true,
    findingsResolved: true,
    ownerMerge: true,
    releaseNotes: true,
    deployed: true,
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
