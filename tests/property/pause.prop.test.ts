import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ReleaseKeys } from '../../src/approvals/keys.js';
import { renderComment } from '../../src/approvals/record.js';
import { sign } from '../../src/approvals/sign.js';
import {
  derivePause,
  resumeEntries,
  type LabelEvent,
  type ResumeEntry,
} from '../../src/pause/derive.js';
import { STATIONS, type ApprovalRecord, type StationName } from '../../src/model/types.js';
import { makeKeys, makeOtherKeys, writeKeyFiles, type TestKeys } from '../helpers/keys.js';

type Scope = 'line' | StationName;
const SCOPES: Scope[] = ['line', 'build', 'verify'];
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString();
const recordAt = (minute: number) => at(minute).replace('.000Z', 'Z');
const NONCES = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(32));

const resume = (scope: Scope, minute: number, nonce: string): ApprovalRecord => ({
  repo: 'baltisark/sample',
  issue: 1,
  gate: 'resume',
  scope,
  timestamp: recordAt(minute),
  nonce,
});

const event: fc.Arbitrary<LabelEvent> = fc
  .record({
    added: fc.boolean(),
    scope: fc.constantFrom(...SCOPES),
    minute: fc.integer({ min: 0, max: 59 }),
    actor: fc.constantFrom('baltisark', 'claude[bot]', 'github-actions'),
  })
  .map(({ added, scope, minute, actor }) => ({
    event: added ? ('labeled' as const) : ('unlabeled' as const),
    label: `pause:${scope}`,
    createdAt: at(minute),
    actor,
  }));
const timeline = fc
  .array(event, { maxLength: 12 })
  .map((events) => [...events].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)));
const entry: fc.Arbitrary<ResumeEntry> = fc
  .record({
    scope: fc.constantFrom(...SCOPES),
    minute: fc.integer({ min: 0, max: 59 }),
    nonce: fc.constantFrom(...NONCES),
    verified: fc.boolean(),
  })
  .map(({ scope, minute, nonce, verified }) => ({
    record: resume(scope, minute, nonce),
    verified,
  }));
const entries = fc.array(entry, { maxLength: 6 });

/** data-model.md § Pause state, written out literally. */
function paused(scope: Scope, events: readonly LabelEvent[], resumes: readonly ResumeEntry[]) {
  const seen = new Set<string>();
  const valid = resumes.filter((r) => {
    if (!r.verified || seen.has(r.record.nonce)) return false;
    seen.add(r.record.nonce);
    return true;
  });
  return events.some(
    (e) =>
      e.event === 'labeled' &&
      e.label === `pause:${scope}` &&
      !valid.some(
        (r) => r.record.scope === scope && Date.parse(r.record.timestamp) > Date.parse(e.createdAt),
      ),
  );
}

const summary = (events: readonly LabelEvent[], resumes: readonly ResumeEntry[]) => {
  const state = derivePause(events, resumes);
  return { line: state.line, stations: [...state.stations].sort() };
};

describe('pause derivation (properties)', () => {
  it('follows the formula: paused = a pause label-add with no later valid resume (AC-076)', () => {
    fc.assert(
      fc.property(timeline, entries, (events, resumes) => {
        const state = derivePause(events, resumes);
        expect(state.line).toBe(paused('line', events, resumes));
        for (const name of ['build', 'verify'] as const) {
          expect(state.stations.has(STATIONS.indexOf(name) as never)).toBe(
            paused(name, events, resumes),
          );
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('never unpauses when a label is removed, whoever added or removed it (AC-076)', () => {
    fc.assert(
      fc.property(timeline, entries, (events, resumes) => {
        const addsOnly = events.filter((e) => e.event === 'labeled');
        const otherActor = events.map((e) => ({ ...e, actor: 'someone-else' }));
        expect(summary(events, resumes)).toEqual(summary(addsOnly, resumes));
        expect(summary(events, resumes)).toEqual(summary(otherActor, resumes));
      }),
      { numRuns: 500 },
    );
  });

  it('never unpauses on an unsigned, replayed or duplicated-nonce resume (AC-077, AC-079)', () => {
    fc.assert(
      fc.property(timeline, entries, entry, fc.nat(), (events, resumes, extra, pick) => {
        const before = summary(events, resumes);
        expect(summary(events, [...resumes, { ...extra, verified: false }])).toEqual(before);
        // Nonces count among verified records only: a forged comment cannot use one up.
        const verified = resumes.filter((r) => r.verified);
        const used = verified[pick % Math.max(verified.length, 1)];
        if (used !== undefined) {
          // A replayed copy, or another record reusing a verified nonce, posted later.
          expect(summary(events, [...resumes, used])).toEqual(before);
          const reused = { record: { ...extra.record, nonce: used.record.nonce }, verified: true };
          expect(summary(events, [...resumes, reused])).toEqual(before);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('never lifts a pause with a resume signed before it, however late it is posted (AC-077)', () => {
    fc.assert(
      fc.property(
        timeline,
        entries,
        fc.constantFrom(...SCOPES),
        fc.integer({ min: 0, max: 59 }),
        fc.nat(),
        (events, resumes, scope, pauseAt, earlier) => {
          const pause: LabelEvent = {
            event: 'labeled',
            label: `pause:${scope}`,
            createdAt: at(pauseAt),
          };
          // Signed at or before the pause (a record at the same second does not lift it either).
          const signedAt = earlier % (pauseAt + 1);
          const old = { record: resume(scope, signedAt, 'f'.repeat(32)), verified: true };
          // Only resumes signed at or before the pause exist for this scope.
          const others = resumes.filter((r) => r.record.scope !== scope);
          const state = derivePause([...events, pause], [...others, old]);
          const isPaused =
            scope === 'line' ? state.line : state.stations.has(STATIONS.indexOf(scope) as never);
          expect(isPaused).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('lists a paused scope whose label is gone so the dispatcher re-applies it (AC-076)', () => {
    fc.assert(
      fc.property(timeline, entries, (events, resumes) => {
        const { missingLabels } = derivePause(events, resumes);
        for (const scope of SCOPES) {
          const label = `pause:${scope}`;
          const last = events.filter((e) => e.label === label).at(-1);
          const shouldRestore = paused(scope, events, resumes) && last?.event === 'unlabeled';
          expect(missingLabels.includes(label)).toBe(shouldRestore);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('resume records from inbox comments', () => {
  let owner: TestKeys;
  let keys: ReleaseKeys;
  beforeAll(() => {
    owner = makeKeys();
    keys = writeKeyFiles([owner]);
  });

  const comment = (record: ApprovalRecord, key: TestKeys, id: string, minute: number) => ({
    id,
    createdAt: at(minute),
    body: renderComment(record, sign(record, key.privateKey, { stdinIsTTY: true })),
  });
  const ctx = () => ({
    keys,
    secondCopy: owner.publicKey,
    repo: 'baltisark/sample',
    inboxIssue: 1,
  });

  it('marks only Owner-signed resume records for this inbox as verified, in posting order', () => {
    const good = resume('line', 5, NONCES[0] ?? '');
    const comments = [
      comment(resume('build', 7, NONCES[1] ?? ''), makeOtherKeys(), 'forged', 8),
      comment({ ...good, issue: 2 }, owner, 'other-issue', 6),
      comment(good, owner, 'good', 5),
      { id: 'chatter', createdAt: at(9), body: 'please resume' },
    ];
    const result = resumeEntries(comments, ctx());
    expect(result.map((e) => [e.record.scope, e.record.issue, e.verified])).toEqual([
      ['line', 1, true],
      ['line', 2, false],
      ['build', 1, false],
    ]);
    expect(
      derivePause([{ event: 'labeled', label: 'pause:line', createdAt: at(4) }], result).line,
    ).toBe(false);
  });

  it('verifies nothing when the second copy of the key does not match (AC-072)', () => {
    const comments = [comment(resume('line', 5, NONCES[0] ?? ''), owner, 'good', 5)];
    const result = resumeEntries(comments, { ...ctx(), secondCopy: makeOtherKeys().publicKey });
    expect(result.every((e) => !e.verified)).toBe(true);
  });
});
