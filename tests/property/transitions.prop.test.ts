// The transition table against the invariants of formal/Dispatcher.tla (research R14): a small
// world in which agents do everything the Owner's GitHub account can do without the key, the
// Owner acts on the laptop, and the dispatcher applies nextTransition to verdicts an honest
// verifier would return.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Verdict } from '../../src/approvals/verify.js';
import {
  nextTransition,
  STATION_OF,
  type Decision,
  type Evidence,
  type ItemStatus,
  type OwnerGate,
} from '../../src/dispatcher/transitions.js';
import { STATES, type State, type Station, type Tier } from '../../src/model/types.js';

const HEAD = '1c9d0e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3';
const OLD_HEAD = '0b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7a8';
const GATES = ['approved', 'spec-approved', 'waiver'] as const;
const OUTPUTS = [
  'intakeComplete',
  'specComplete',
  'draftPr',
  'planComplete',
  'tasksDone',
  'verifyReport',
  'findingsResolved',
  'releaseNotes',
] as const;
type Output = (typeof OUTPUTS)[number];
const FORWARD: readonly State[] = STATES.slice(0, 10);
const at = (s: State) => FORWARD.indexOf(s);

/** Who made the latest add of an owner: label: the Owner, or an agent forging, replaying or
 * passing off another gate's record. */
type LabelBy = 'owner' | 'forged' | 'replayed' | 'other-gate';

interface World {
  state: State;
  blockedFrom?: State | undefined;
  labels: Partial<Record<OwnerGate, LabelBy | undefined>>;
  /** Ghost: what the Owner signed and has not withdrawn. */
  intent: { approved?: Tier; spec?: number };
  spec: number;
  ownerMerged: boolean;
  deployed: boolean;
  historySigned: boolean;
  rotationPending: boolean;
  line: boolean;
  stations: Set<Station>;
  outputs: Record<Output, boolean>;
  redGreen: 'none' | 'green' | 'red' | 'old-head';
  questionOpen: boolean;
  failure?: Station | undefined;
}

const fresh = (): World => ({
  state: 'new',
  labels: {},
  intent: {},
  spec: 0,
  ownerMerged: false,
  deployed: false,
  historySigned: true,
  rotationPending: false,
  line: false,
  stations: new Set(),
  outputs: Object.fromEntries(OUTPUTS.map((o) => [o, false])) as Record<Output, boolean>,
  redGreen: 'none',
  questionOpen: false,
});

const specIntent = (w: World) => w.intent.spec === w.spec || w.intent.approved === 1;

function verdict(w: World, gate: OwnerGate): Verdict {
  const by = w.labels[gate];
  if (by === undefined) return { ok: false, kind: 'missing', reason: 'no label' };
  if (by === 'forged') return { ok: false, kind: 'tampering', reason: 'no record' };
  if (by === 'replayed') return { ok: false, kind: 'replay', reason: 'reused nonce' };
  if (gate === 'spec-approved' && by === 'owner' && w.intent.spec !== w.spec)
    return { ok: false, kind: 'stale', reason: 'spec.md changed' };
  const recordGate = by === 'other-gate' ? (GATES.find((g) => g !== gate) ?? gate) : gate;
  const record = {
    repo: 'baltisark/sample',
    issue: 42,
    gate: recordGate,
    tier: w.intent.approved ?? 2,
    timestamp: '2026-10-01T09:12:44Z',
    nonce: 'a'.repeat(32),
  };
  return { ok: true, record, comment: { id: 'c', createdAt: record.timestamp, body: '' } };
}

const status = (w: World): ItemStatus =>
  w.blockedFrom === undefined ? { state: w.state } : { state: w.state, blockedFrom: w.blockedFrom };

const evidence = (w: World): Evidence => ({
  rotationPending: w.rotationPending,
  historySigned: w.historySigned,
  owner: {
    approved: verdict(w, 'approved'),
    'spec-approved': verdict(w, 'spec-approved'),
    waiver: verdict(w, 'waiver'),
  },
  questionOpen: w.questionOpen,
  ...(w.failure === undefined ? {} : { failure: { station: w.failure, reason: 'report' } }),
  ...w.outputs,
  branchHead: HEAD,
  ...(w.redGreen === 'none'
    ? {}
    : {
        redGreen: {
          head: w.redGreen === 'old-head' ? OLD_HEAD : HEAD,
          green: w.redGreen !== 'red',
        },
      }),
  ownerMerge: w.ownerMerged,
  deployed: w.deployed,
});

type Action =
  // Owner, on the laptop with the key
  | { by: 'owner'; act: 'approve'; tier: Tier }
  | { by: 'owner'; act: 'spec-approve' | 'waive' | 'merge' | 'deploy' | 'answer' }
  | { by: 'owner'; act: 'withdraw'; gate: OwnerGate }
  | { by: 'owner'; act: 'resume'; scope: 'line' | Station }
  | { by: 'owner'; act: 'rotate'; pending: boolean }
  // Agents: the Owner's GitHub account without the key
  | { by: 'agent'; act: 'label'; gate: OwnerGate; how: Exclude<LabelBy, 'owner'> }
  | { by: 'agent'; act: 'unlabel'; gate: OwnerGate }
  | { by: 'agent'; act: 'edit-spec' | 'push-main' | 'ask' }
  | { by: 'agent'; act: 'pause'; scope: 'line' | Station }
  | { by: 'agent'; act: 'set-state'; state: State; from?: State | undefined }
  | { by: 'agent'; act: 'output'; name: Output; value: boolean }
  | { by: 'agent'; act: 'red-green'; value: World['redGreen'] }
  | { by: 'agent'; act: 'fail'; station?: Station | undefined }
  // The dispatcher
  | { by: 'dispatcher' };

const gate = fc.constantFrom(...GATES);
const scope = fc.constantFrom<'line' | Station>('line', 2, 4, 5, 6);
const station = fc.constantFrom<Station>(1, 2, 3, 4, 5, 6, 7);
const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 6, arbitrary: fc.constant({ by: 'dispatcher' as const }) },
  fc.record({
    by: fc.constant('owner' as const),
    act: fc.constant('approve' as const),
    tier: fc.constantFrom<Tier>(1, 2, 3),
  }),
  fc.record({
    by: fc.constant('owner' as const),
    act: fc.constantFrom<'spec-approve' | 'waive' | 'merge' | 'deploy' | 'answer'>(
      'spec-approve',
      'waive',
      'merge',
      'deploy',
      'answer',
    ),
  }),
  fc.record({ by: fc.constant('owner' as const), act: fc.constant('withdraw' as const), gate }),
  fc.record({ by: fc.constant('owner' as const), act: fc.constant('resume' as const), scope }),
  fc.record({
    by: fc.constant('owner' as const),
    act: fc.constant('rotate' as const),
    pending: fc.boolean(),
  }),
  fc.record({
    by: fc.constant('agent' as const),
    act: fc.constant('label' as const),
    gate,
    how: fc.constantFrom<Exclude<LabelBy, 'owner'>>('forged', 'replayed', 'other-gate'),
  }),
  fc.record({ by: fc.constant('agent' as const), act: fc.constant('unlabel' as const), gate }),
  fc.record({
    by: fc.constant('agent' as const),
    act: fc.constantFrom<'edit-spec' | 'push-main' | 'ask'>('edit-spec', 'push-main', 'ask'),
  }),
  fc.record({ by: fc.constant('agent' as const), act: fc.constant('pause' as const), scope }),
  // Forged `state:` label history: the current state and, for `blocked`, the state it left.
  fc.record({
    by: fc.constant('agent' as const),
    act: fc.constant('set-state' as const),
    state: fc.constantFrom(...STATES),
    from: fc.option(fc.constantFrom(...STATES), { nil: undefined }),
  }),
  {
    weight: 3,
    arbitrary: fc.record({
      by: fc.constant('agent' as const),
      act: fc.constant('output' as const),
      name: fc.constantFrom(...OUTPUTS),
      value: fc.boolean(),
    }),
  },
  fc.record({
    by: fc.constant('agent' as const),
    act: fc.constant('red-green' as const),
    value: fc.constantFrom<World['redGreen']>('none', 'green', 'red', 'old-head'),
  }),
  fc.record({
    by: fc.constant('agent' as const),
    act: fc.constant('fail' as const),
    station: fc.option(station, { nil: undefined }),
  }),
);

/** The laptop checks of `factory merge`: signed history and the Owner's current approvals. */
const laptopOk = (w: World) => w.historySigned && !w.rotationPending;

function apply(w: World, a: Action): void {
  if (a.by === 'dispatcher') return;
  if (a.by === 'owner') {
    switch (a.act) {
      case 'approve':
        w.labels.approved = 'owner';
        w.intent.approved = a.tier;
        return;
      case 'spec-approve':
        w.labels['spec-approved'] = 'owner';
        w.intent.spec = w.spec;
        return;
      case 'waive':
        w.labels.waiver = 'owner';
        return;
      case 'withdraw':
        w.labels[a.gate] = undefined;
        if (a.gate === 'approved') delete w.intent.approved;
        if (a.gate === 'spec-approved') delete w.intent.spec;
        return;
      case 'merge':
        if (laptopOk(w) && w.intent.approved !== undefined && specIntent(w)) w.ownerMerged = true;
        return;
      case 'deploy':
        if (laptopOk(w) && w.ownerMerged) w.deployed = true;
        return;
      case 'answer':
        w.questionOpen = false;
        return;
      case 'resume':
        if (a.scope === 'line') w.line = false;
        else w.stations.delete(a.scope);
        return;
      case 'rotate':
        w.rotationPending = a.pending;
        return;
    }
  }
  switch (a.act) {
    case 'label':
      if (w.labels[a.gate] === undefined) w.labels[a.gate] = a.how;
      return;
    case 'unlabel':
      w.labels[a.gate] = undefined;
      return;
    case 'edit-spec':
      w.spec += 1;
      return;
    case 'push-main':
      w.historySigned = false;
      return;
    case 'ask':
      w.questionOpen = true;
      return;
    case 'pause':
      if (a.scope === 'line') w.line = true;
      else w.stations.add(a.scope);
      return;
    case 'set-state':
      w.state = a.state;
      w.blockedFrom = a.from;
      return;
    case 'output':
      w.outputs[a.name] = a.value;
      return;
    case 'red-green':
      w.redGreen = a.value;
      return;
    case 'fail':
      w.failure = a.station;
      return;
  }
}

/** Invariants of formal/Dispatcher.tla, checked on one dispatcher decision. */
function checkInvariants(w: World, from: State, d: Decision): void {
  if (!d.ok) return;
  // PausedLineNeverAdvances, TamperedMainHalts, and rotation-pending halts everything.
  expect(w.line, 'moved while pause:line').toBe(false);
  expect(w.historySigned, 'moved with an unsigned commit on main').toBe(true);
  expect(w.rotationPending, 'moved during a key rotation').toBe(false);
  if (d.to === 'escalated' || d.to === 'blocked') return;
  // No entry to a paused station.
  const entered = STATION_OF[d.to];
  if (entered !== undefined && entered !== STATION_OF[from])
    expect(w.stations.has(entered), `entered paused station ${String(entered)}`).toBe(false);
  // GateOnlyOnOwnLabel: every state past a gate rests on the Owner's current approval.
  if (at(d.to) >= at('triaged'))
    expect(w.intent.approved, `${from} → ${d.to} without owner approval`).toBeDefined();
  if (at(d.to) >= at('spec-approved'))
    expect(specIntent(w), `${from} → ${d.to} without spec approval`).toBe(true);
  // NoMergeWithoutOwner, NoDeployWithoutOwner.
  if (at(d.to) >= at('releasing')) expect(w.ownerMerged, `${from} → ${d.to} unmerged`).toBe(true);
  if (d.to === 'done') expect(w.deployed, `${from} → done undeployed`).toBe(true);
}

function run(actions: readonly Action[]): World {
  const w = fresh();
  for (const a of actions) {
    if (a.by !== 'dispatcher') {
      apply(w, a);
      continue;
    }
    const from = w.state;
    const d = nextTransition(status(w), evidence(w), {
      line: w.line,
      stations: w.stations,
    });
    checkInvariants(w, from, d);
    if (!d.ok) continue;
    if (d.to === 'blocked') w.blockedFrom = from;
    w.state = d.to;
  }
  return w;
}

describe('transition table against the TLA+ invariants (AC-069)', () => {
  it('keeps NoMergeWithoutOwner, NoDeployWithoutOwner, PausedLineNeverAdvances and GateOnlyOnOwnLabel', () => {
    fc.assert(
      fc.property(fc.array(action, { maxLength: 60 }), (actions) => {
        run(actions);
      }),
      { numRuns: 2000 },
    );
  });

  it('escalates whenever an owner: label is forged or replayed and nothing halts the line', () => {
    fc.assert(
      fc.property(
        fc.array(action, { maxLength: 30 }),
        gate,
        fc.constantFrom<'forged' | 'replayed'>('forged', 'replayed'),
        (actions, g, how) => {
          const w = run(actions);
          if (w.state === 'done' || w.state === 'escalated') return;
          w.labels[g] = how;
          const d = nextTransition(status(w), evidence(w), {
            line: w.line,
            stations: w.stations,
          });
          const halted = w.line || !w.historySigned || w.rotationPending;
          expect(d).toMatchObject(halted ? { ok: false } : { ok: true, to: 'escalated' });
        },
      ),
      { numRuns: 500 },
    );
  });

  it('is not vacuous: the honest Owner path reaches done', () => {
    const step = { by: 'dispatcher' } as const;
    const out = (name: Output): Action => ({ by: 'agent', act: 'output', name, value: true });
    const w = run([
      { by: 'owner', act: 'approve', tier: 2 },
      out('intakeComplete'),
      step,
      out('specComplete'),
      out('draftPr'),
      step,
      { by: 'owner', act: 'spec-approve' },
      step,
      out('planComplete'),
      step,
      step,
      out('tasksDone'),
      { by: 'agent', act: 'red-green', value: 'green' },
      step,
      out('verifyReport'),
      out('findingsResolved'),
      step,
      { by: 'owner', act: 'merge' },
      step,
      out('releaseNotes'),
      { by: 'owner', act: 'deploy' },
      step,
    ]);
    expect(w.state).toBe('done');
  });
});
