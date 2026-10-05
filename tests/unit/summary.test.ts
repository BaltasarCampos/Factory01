import { describe, expect, it } from 'vitest';
import { trace, traceBack, untrailered, type TraceInput } from '../../src/events/trace.js';
import { buildSummary, type SummaryFacts } from '../../src/notify/summary.js';

const BRANCH = 'claude/42-add-login';

const SPEC = `# Feature Specification: Add login

## Problem *(mandatory)*

Visitors cannot sign in, so every saved link is public.

## Non-goals *(mandatory)*

- Social login.

## Affected areas *(mandatory)*

- \`src/auth/\` and the login page.

## User Scenarios & Testing *(mandatory)*

1. **AC-001** — **Given** a registered user, **When** they sign in, **Then** they see their links.
2. **AC-002** — **Given** a wrong password, **When** they sign in, **Then** they see an error.
`;

const TASKS = `# Tasks: Add login

## Phase 3: User Story 1

### Tests for User Story 1

- [ ] T002 [US1] Integration test for sign-in (AC-001) · Files: tests/integration/login.test.ts

### Implementation for User Story 1

- [ ] T004 [US1] Sign-in handler · Files: src/auth/login.ts
`;

const VERIFY = `| Check | Result |\n|---|---|\n${['CI', 'Coverage', 'SAST', 'SCA', 'Secrets', 'Licences', 'Review'].map((c) => `| ${c} | pass |`).join('\n')}\n`;

const usage = (sessions: number, share: number) =>
  JSON.stringify({ kind: 'usage', item: 42, usage: { sessions, est_share: share } });
const EVENTS = `${usage(1, 0.02)}\n${JSON.stringify({ kind: 'tool_call', item: 42 })}\n${usage(2, 0.03)}\n`;

const ISSUE = {
  number: 42,
  title: 'Add login',
  body: 'Let visitors sign in.\n\nOnly email and password.',
  labels: ['tier:2', 'type:feature', 'priority:p1'],
};
const facts = (over: Partial<SummaryFacts> = {}): SummaryFacts => ({
  gate: 'spec-approved',
  issue: ISSUE,
  tier: 2,
  branch: BRANCH,
  files: { spec: SPEC, tasks: TASKS, events: EVENTS },
  ...over,
});

/** The summary text, failing the test when it was refused. */
const text = (f: SummaryFacts) => {
  const s = buildSummary(f);
  if (!s.ok) throw new Error(`refused: ${s.missing.join('; ')}`);
  return s.text;
};

describe('approval summary (AC-016)', () => {
  it('AC-016: shows what changed, spec mapping, tests and review, usage spent and known risks', () => {
    const t = text(facts({ files: { spec: SPEC, tasks: TASKS, verify: VERIFY, events: EVENTS } }));
    for (const part of [
      'What changed',
      'Spec mapping',
      'Tests and review',
      'Usage spent',
      'Known risks',
    ])
      expect(t).toMatch(new RegExp(`^${part}$`, 'm'));
    expect(t).toMatch(/#42: Add login/);
    expect(t).toMatch(/Visitors cannot sign in/);
    expect(t).toMatch(/AC-001 → T002/);
    expect(t).toMatch(/AC-002 → no test task/);
    expect(t).toMatch(/all checks pass/);
    expect(t).toMatch(/3 sessions, about 5% of the plan's usage/);
    expect(t).toMatch(/Tier 2/);
  });

  it('AC-016: an item approval names the request and states that spec, tests and usage come later', () => {
    const t = text(facts({ gate: 'approved', files: undefined }));
    expect(t).toMatch(/Let visitors sign in\./);
    expect(t).toMatch(/No spec yet: Specify writes it on claude\/42-add-login/);
    expect(t).toMatch(/None yet: this gate comes before Build/);
    expect(t).toMatch(/None logged yet/);
    expect(t).toMatch(/type:feature, priority:p1/);
  });

  it('AC-016: a tier 1 item approval says the spec is not approved separately', () => {
    expect(text(facts({ gate: 'approved', tier: 1, files: undefined }))).toMatch(
      /tier 1: the spec is not approved separately/,
    );
  });

  it('AC-016: refuses when the spec defines no acceptance criteria to map', () => {
    expect(buildSummary(facts({ files: { spec: '# Add login\n', events: EVENTS } }))).toEqual({
      ok: false,
      missing: ['Spec mapping: spec.md defines no acceptance criteria'],
    });
  });

  it('AC-016: refuses the spec gate without a spec.md on the branch', () => {
    expect(buildSummary(facts({ files: { events: EVENTS } }))).toEqual({
      ok: false,
      missing: ['Spec mapping: no spec.md on claude/42-add-login'],
    });
  });

  it('AC-016: refuses a tier 3 spec without a Risks section', () => {
    const s = buildSummary(facts({ tier: 3 }));
    expect(s).toEqual({
      ok: false,
      missing: ['Known risks: tier 3 needs a Risks section in spec.md'],
    });
    const risky = `${SPEC}\n## Risks\n\n- Lockout logic could block real users.\n`;
    expect(text(facts({ tier: 3, files: { spec: risky, events: EVENTS } }))).toMatch(
      /Lockout logic could block real users/,
    );
  });

  it('AC-016: lists failing checks and open blocking findings from the verify report', () => {
    const report = `${VERIFY.replace('| SCA | pass |', '| SCA | fail |')}\n- [ ] blocking: SQL built by concatenation\n`;
    const t = text(facts({ gate: 'waiver', waives: 'gate:coverage', files: { verify: report } }));
    expect(t).toMatch(/SCA: fail/);
    expect(t).toMatch(/unresolved blocking finding: SQL built by concatenation/);
    expect(t).toMatch(/Waives gate:coverage/);
  });

  it('AC-016: a waiver names its target and the PR head it is bound to', () => {
    const head = '1c9d0e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3';
    const t = text(facts({ gate: 'waiver', waives: 'gate:coverage', head, files: {} }));
    expect(t).toMatch(/Waives gate:coverage for PR head 1c9d0e5f6a7b/);
    expect(t).toMatch(/No spec.md on claude\/42-add-login yet/);
    expect(t).toMatch(/No reports\/verify.md on claude\/42-add-login yet/);
    expect(t).toMatch(/No events.jsonl on claude\/42-add-login yet/);
  });

  it('AC-016: a waiver on an issue that is not a work item says no spec, tests or usage apply', () => {
    const t = text({
      gate: 'waiver',
      issue: { number: 9, title: 'Secret in log output', body: '', labels: ['security'] },
      waives: 'finding:secret-in-log@src/app.ts:12',
    });
    expect(t).toMatch(/Not a work item/);
    expect(t).toMatch(/the finding stays unfixed/);
  });

  it('AC-016: counts unreadable event lines instead of trusting them', () => {
    const t = text(facts({ files: { spec: SPEC, events: `${usage(1, 0.5)}\nnot json\n` } }));
    expect(t).toMatch(/1 session, about 50% of the plan's usage/);
    expect(t).toMatch(/1 unreadable line/);
  });

  it('AC-016: issue text cannot hide lines from the Owner with terminal control codes', () => {
    const body = 'Fine change\u001b[8m hidden\u001b[0m\u0007';
    const t = text(facts({ gate: 'approved', issue: { ...ISSUE, body }, files: undefined }));
    expect(t).not.toMatch(/\u001b|\u0007/);
    expect(t).toMatch(/Fine change\?\[8m hidden/);
  });
});

const FEATURE = '42-add-login';
const trailers = (role = 'builder', item = FEATURE) =>
  `\n\nFactory-Role: ${role}\nFactory-Item: ${item}\n`;
const ITEM_TRACE: TraceInput = {
  issue: 42,
  title: 'Add login',
  feature: FEATURE,
  files: { spec: SPEC, plan: '# Plan\n', tasks: TASKS, verify: VERIFY },
  commits: [
    { sha: 'a1'.repeat(20), message: `feat: sign-in handler${trailers()}`, parents: 1 },
    { sha: 'b2'.repeat(20), message: `test: sign-in${trailers('test')}`, parents: 1 },
  ],
  tests: [
    'sign-in › AC-001: a registered user sees their links',
    'sign-in › AC-002: a wrong password shows an error',
  ],
  release: {
    version: 'v1.2.0',
    notes: '## v1.2.0\n\n- #42 Add login\n\nRollback: redeploy v1.1.0\n',
  },
};

describe('item trace (AC-017)', () => {
  it('AC-017: links request → spec → plan → tasks → commits → review → tests → release', () => {
    const t = trace(ITEM_TRACE);
    expect(t.links.map((l) => l.step)).toEqual([
      'request',
      'spec',
      'plan',
      'tasks',
      'commits',
      'review',
      'tests',
      'release',
    ]);
    expect(t.gaps).toEqual([]);
    expect(t.untrailered).toEqual([]);
    expect(t.links.find((l) => l.step === 'spec')?.refs).toEqual(['specs/42-add-login/spec.md']);
    expect(t.links.find((l) => l.step === 'commits')?.refs).toEqual([
      'a1a1a1a1a1a1',
      'b2b2b2b2b2b2',
    ]);
    expect(t.links.find((l) => l.step === 'release')?.refs).toEqual(['v1.2.0']);
  });

  it('AC-017: a deployed change is followed back from its release, a commit or a test', () => {
    const t = trace(ITEM_TRACE);
    const back = (ref: string) => traceBack(t, ref).map((l) => l.step);
    expect(back('v1.2.0')).toEqual([
      'release',
      'tests',
      'review',
      'commits',
      'tasks',
      'plan',
      'spec',
      'request',
    ]);
    expect(back('a1a1a1a')).toEqual(['commits', 'tasks', 'plan', 'spec', 'request']);
    expect(back('sign-in › AC-002: a wrong password shows an error')[0]).toBe('tests');
    expect(traceBack(t, 'v9.9.9')).toEqual([]);
  });

  it('AC-017: reports each break in the chain', () => {
    const t = trace({
      ...ITEM_TRACE,
      files: { spec: SPEC },
      tests: ['sign-in › AC-001: a registered user sees their links'],
      release: { version: 'v1.2.0', notes: 'Rollback: redeploy v1.1.0\n' },
    });
    expect(t.gaps).toEqual([
      'plan: no plan.md in specs/42-add-login',
      'tasks: no tasks.md in specs/42-add-login',
      'review: no reports/verify.md in specs/42-add-login',
      'tests: AC-002 has no test naming it',
      'release: the notes of v1.2.0 do not name #42',
    ]);
    expect(trace({ ...ITEM_TRACE, release: undefined, commits: [] }).gaps).toEqual([
      'commits: no commit names the item in Factory-Item:',
      'release: not released yet',
    ]);
  });

  it('AC-017: flags every agent commit without Factory-Role: and Factory-Item: trailers', () => {
    const commits = [
      { sha: 'c3'.repeat(20), message: 'fix: tidy up\n', parents: 1 },
      { sha: 'd4'.repeat(20), message: `feat: x${trailers('wizard')}`, parents: 1 },
      { sha: 'e5'.repeat(20), message: `feat: y${trailers('builder', '43-other')}`, parents: 1 },
      {
        sha: 'f6'.repeat(20),
        message: `feat: z${trailers('builder', `${FEATURE}/T004`)}`,
        parents: 1,
      },
      { sha: '07'.repeat(20), message: "Merge branch 'main'\n", parents: 2 },
      {
        sha: '18'.repeat(20),
        message: 'feat: w\n\nFactory-Role: builder\n\nFactory-Item: 42-add-login\n',
        parents: 1,
      },
    ];
    expect(untrailered(commits, FEATURE)).toEqual([
      'c3c3c3c3c3c3 fix: tidy up: no Factory-Role: trailer',
      'c3c3c3c3c3c3 fix: tidy up: no Factory-Item: trailer',
      'd4d4d4d4d4d4 feat: x: Factory-Role: wizard is not a factory role',
      'e5e5e5e5e5e5 feat: y: Factory-Item: 43-other is not 42-add-login',
      '181818181818 feat: w: no Factory-Role: trailer',
    ]);
    expect(trace({ ...ITEM_TRACE, commits }).untrailered).toHaveLength(5);
  });
});
