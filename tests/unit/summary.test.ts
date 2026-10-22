import { describe, expect, it } from 'vitest';
import { trace, traceBack, untrailered, type TraceInput } from '../../src/events/trace.js';
import {
  buildSummary,
  GATE_PARTS,
  PART_TITLES,
  type BranchMergeView,
  type DeployView,
  type HealthView,
  type MergeView,
  type SummaryFacts,
} from '../../src/notify/summary.js';

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

const VERIFY = '| Check | Result |\n|---|---|\n| Review | pass |\n';
const SECURITY = '## Scans\n\n- semgrep: none\n- gitleaks: none\n\n## Findings\n\n- none\n';

const usage = (sessions: number, share: number) =>
  JSON.stringify({ kind: 'usage', item: 42, usage: { sessions, est_share: share } });
const EVENTS = `${usage(1, 0.02)}\n${JSON.stringify({ kind: 'tool_call', item: 42 })}\n${usage(2, 0.03)}\n`;

const ISSUE = {
  number: 42,
  title: 'Add login',
  body: 'Let visitors sign in.\n\nOnly email and password.',
  labels: ['tier:2', 'type:feature', 'priority:p1'],
};
const COMMIT = '5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f';
const facts = (over: Partial<SummaryFacts> = {}): SummaryFacts => ({
  gate: 'spec-approved',
  issue: ISSUE,
  tier: 2,
  branch: BRANCH,
  commit: COMMIT,
  files: { spec: SPEC, tasks: TASKS, events: EVENTS },
  ...over,
});

/** The summary text, failing the test when it was refused. */
const text = (f: SummaryFacts) => {
  const s = buildSummary(f);
  if (!s.ok) throw new Error(`refused: ${s.missing.join('; ')}`);
  return s.text;
};
/** The lines of one part of a summary, without their indent. */
const part = (t: string, title: string) => {
  const lines = t.split('\n');
  const start = lines.indexOf(title) + 1;
  const end = lines.findIndex((l, i) => i >= start && !l.startsWith('  '));
  return lines.slice(start, end === -1 ? undefined : end).map((l) => l.trim());
};

describe('the per-gate list (data-model § Approval summary)', () => {
  it('AC-016: marks every part of every gate required, not applicable or shown; usage is never required', () => {
    for (const [gate, parts] of Object.entries(GATE_PARTS)) {
      expect(Object.keys(parts).sort(), gate).toEqual(Object.keys(PART_TITLES).sort());
      expect(parts.usage, gate).not.toBe('required');
      expect(parts.changed, gate).toBe('required');
      expect(parts.risks, gate).toBe('required');
    }
    expect(GATE_PARTS.admission.mapping).toBe('n/a');
    expect(GATE_PARTS.spec.mapping).toBe('required');
  });

  it('AC-016: a part the list marks not applicable shows —, and the summary prints the commit read', () => {
    const t = text(facts());
    expect(t).toMatch(new RegExp(`at ${COMMIT}`));
    expect(part(t, 'Tests and review')).toEqual(['—']);
  });
});

describe('item approval (AC-091)', () => {
  const admission = (over: Partial<SummaryFacts> = {}) =>
    facts({ gate: 'approved', files: undefined, commit: undefined, ...over });

  it('AC-091: shows the request quoted from the issue, and the tier as the known risk', () => {
    const t = text(admission());
    expect(part(t, 'What changed')).toEqual([
      'Request #42: Add login',
      'quoted from issue #42:',
      '> Let visitors sign in.',
      '> Only email and password.',
    ]);
    expect(part(t, 'Spec mapping')).toEqual(['—']);
    expect(part(t, 'Known risks')).toEqual(['Tier 2', 'Other labels: type:feature, priority:p1']);
  });

  it('AC-091: other labels are shown only if present; Intake has not run yet', () => {
    const t = text(admission({ issue: { ...ISSUE, labels: ['tier:2'] } }));
    expect(part(t, 'Known risks')).toEqual(['Tier 2']);
  });

  it('AC-091: refuses without a tier', () => {
    expect(buildSummary(admission({ tier: undefined }))).toEqual({
      ok: false,
      missing: ['Known risks: no tier (give one with --tier or a single proposed tier: label)'],
    });
  });

  it('AC-091: usage is shown as unavailable rather than refusing', () => {
    expect(part(text(admission()), 'Usage spent')).toEqual(['unavailable (telemetry missing)']);
  });
});

describe('spec approval (AC-092)', () => {
  it('AC-092: a first approval quotes Problem and Affected areas and lists every AC-###', () => {
    const t = text(facts());
    expect(part(t, 'What changed')).toEqual([
      'Request #42: Add login',
      `quoted from specs/42-add-login/spec.md at ${COMMIT.slice(0, 12)}:`,
      '> Problem: Visitors cannot sign in, so every saved link is public.',
      '> Affected areas: `src/auth/` and the login page.',
    ]);
    expect(part(t, 'Spec mapping')).toEqual([
      `quoted from specs/42-add-login/spec.md at ${COMMIT.slice(0, 12)}:`,
      '> AC-001: Given a registered user, When they sign in, Then they see their links.',
      '> AC-002: Given a wrong password, When they sign in, Then they see an error.',
    ]);
  });

  it('AC-092: a re-approval shows the spec.md diff from the last approved blob', () => {
    const diff = '@@ -1 +1 @@\n-old line\n+new line';
    const t = text(facts({ previousSpec: { blob: 'b'.repeat(40), diff } }));
    expect(part(t, 'What changed')).toEqual([
      'Request #42: Add login',
      `spec.md changed since the approved blob bbbbbbbbbbbb (diff to ${COMMIT.slice(0, 12)}):`,
      '> @@ -1 +1 @@',
      '> -old line',
      '> +new line',
    ]);
    const unchanged = text(facts({ previousSpec: { blob: 'b'.repeat(40), diff: '' } }));
    expect(part(unchanged, 'What changed')).toContain(
      'spec.md is unchanged since the approved blob bbbbbbbbbbbb',
    );
  });

  it('AC-092: when the previously approved spec cannot be read, shows the full spec instead of refusing', () => {
    const t = text(facts({ previousSpec: { blob: 'b'.repeat(40), diff: undefined } }));
    const lines = part(t, 'What changed');
    expect(lines.slice(0, 3)).toEqual([
      'Request #42: Add login',
      'the previously approved spec.md bbbbbbbbbbbb is not available: showing the full spec',
      `quoted from specs/42-add-login/spec.md at ${COMMIT.slice(0, 12)}:`,
    ]);
    expect(lines).toContain('> # Feature Specification: Add login');
    expect(lines).toContain('> Visitors cannot sign in, so every saved link is public.');
  });

  it('AC-092: refuses when the spec defines no AC-###, or there is no spec.md', () => {
    expect(buildSummary(facts({ files: { spec: '# Add login\n', events: EVENTS } }))).toEqual({
      ok: false,
      missing: ['Spec mapping: spec.md defines no acceptance criteria'],
    });
    expect(buildSummary(facts({ files: { events: EVENTS } }))).toEqual({
      ok: false,
      missing: [
        'What changed: no spec.md on claude/42-add-login',
        'Spec mapping: no spec.md on claude/42-add-login',
        'Known risks: no spec.md on claude/42-add-login',
      ],
    });
  });

  it('AC-092: refuses a tier 3 spec without a Risks section, and quotes it when present', () => {
    expect(buildSummary(facts({ tier: 3 }))).toEqual({
      ok: false,
      missing: ['Known risks: tier 3 needs a Risks section in spec.md'],
    });
    const risky = `${SPEC}\n## Risks\n\n- Lockout logic could block real users.\n`;
    const t = text(facts({ tier: 3, files: { spec: risky, events: EVENTS } }));
    expect(part(t, 'Known risks')).toEqual([
      'Tier 3',
      'the formal check is not in this release: factory merge refuses a tier 3 item',
      `quoted from specs/42-add-login/spec.md at ${COMMIT.slice(0, 12)}:`,
      '> Lockout logic could block real users.',
    ]);
    expect(part(text(facts({ gate: 'approved', tier: 3 })), 'Known risks')).toContain(
      'the formal check is not in this release: factory merge refuses a tier 3 item',
    );
    expect(part(text(facts()), 'Known risks')).toEqual([
      'Tier 2',
      'none identified (spec.md has no Risks section; required only at tier 3)',
    ]);
  });

  it('AC-016: sums usage events, counts unreadable lines, and says so when telemetry is missing', () => {
    expect(part(text(facts()), 'Usage spent')).toEqual([
      "3 sessions, about 5% of the plan's usage, from 2 usage events in events.jsonl (telemetry, unverified)",
    ]);
    const odd = text(facts({ files: { spec: SPEC, events: `${usage(1, 0.5)}\nnot json\n` } }));
    expect(part(odd, 'Usage spent')).toEqual([
      "1 session, about 50% of the plan's usage, from 1 usage event in events.jsonl (telemetry, unverified)",
      '1 unreadable line not counted',
    ]);
    expect(part(text(facts({ files: { spec: SPEC } })), 'Usage spent')).toEqual([
      'unavailable (telemetry missing)',
    ]);
  });
});

describe('waivers (AC-093)', () => {
  it('AC-093: a pre-build gate waiver names its target, with the tier as risk', () => {
    const t = text(facts({ gate: 'waiver', waives: 'gate:plan', files: {} }));
    expect(part(t, 'What changed')).toEqual(['Request #42: Add login', 'Waives gate:plan']);
    expect(part(t, 'Known risks')).toEqual(['Tier 2']);
  });

  it('AC-093: a code-gate waiver refuses, naming the check this release does not have yet', () => {
    const head = COMMIT;
    const files = { spec: SPEC, tasks: TASKS };
    const s = buildSummary(facts({ gate: 'waiver', waives: 'gate:coverage', head, files }));
    expect(s).toEqual({
      ok: false,
      missing: [
        'Tests and review: this release has no coverage check yet, so there is nothing to waive',
        'Known risks: what the waiver lets through comes from the coverage check, which this release does not have yet',
      ],
    });
  });

  it('AC-093: a waiver on an issue that is not a work item says what stays unfixed', () => {
    const t = text({
      gate: 'waiver',
      issue: { number: 9, title: 'Secret in log output', body: '', labels: ['security'] },
      waives: 'finding:secret-in-log@src/app.ts:12',
    });
    expect(part(t, 'Spec mapping')).toEqual(['—']);
    expect(part(t, 'Usage spent')).toEqual(['—']);
    expect(part(t, 'Known risks')).toEqual([
      'Waiver of finding:secret-in-log@src/app.ts:12 on #9: the finding stays unfixed',
      'Other labels: security',
    ]);
  });
});

describe('gates built later (T053, T068)', () => {
  it("AC-094: a merge summary without the merge checks' results refuses every part they give", () => {
    const s = buildSummary(
      facts({ gate: 'merge', kind: 'merge', files: { spec: SPEC, verify: VERIFY } }),
    );

    expect(s.ok ? [] : s.missing.map((m) => m.split(':')[0])).toEqual([
      'What changed',
      'Spec mapping',
      'Tests and review',
    ]);
  });

  it('a Define, log or factory-repository merge summary without its view refuses every part it requires', () => {
    const s = buildSummary(facts({ gate: 'merge', kind: 'merge-branch' }));

    expect(s.ok ? [] : s.missing.map((m) => m.split(':')[0])).toEqual([
      'What changed',
      'Tests and review',
      'Known risks',
    ]);
  });
});

describe('quoted text is cleaned by Unicode category (FR-043)', () => {
  const shown = (body: string) =>
    part(
      text(facts({ gate: 'approved', issue: { ...ISSUE, body }, files: undefined })),
      'What changed',
    )[2];

  it('AC-016: removes control characters (Cc), C0 and C1 alike', () => {
    expect(shown('Fine\u001b[8m hidden\u0007 \u0085done')).toBe('> Fine[8m hidden done');
  });

  it('AC-016: removes format characters (Cf): bidi overrides and zero-width characters', () => {
    expect(shown('pay ‮eulav‬ ​now⁦x⁩﻿')).toBe('> pay eulav nowx');
  });

  it('AC-016: removes line separators (Zl), so no text can fake a line', () => {
    expect(shown('one Known risks')).toBe('> oneKnown risks');
  });

  it('AC-016: removes paragraph separators (Zp)', () => {
    expect(shown('one two')).toBe('> onetwo');
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

  it('AC-017: the review step names Security’s report too, and never misses it (T168)', () => {
    const review = (files: TraceInput['files']) =>
      trace({ ...ITEM_TRACE, files }).links.find((l) => l.step === 'review')?.refs;
    expect(review({ ...ITEM_TRACE.files, security: SECURITY })).toEqual([
      'specs/42-add-login/reports/verify.md',
      'specs/42-add-login/reports/security.md',
    ]);
    expect(review(ITEM_TRACE.files)).toEqual(['specs/42-add-login/reports/verify.md']);
    expect(trace(ITEM_TRACE).gaps).toEqual([]);
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
      { sha: '07'.repeat(20), message: "Merge branch 'main'\n", parents: 2, cleanMerge: true },
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

  it('AC-017, T170: accepts Factory-Role: dispatcher only on commits limited to the files the dispatcher writes, never .specify/feature.json', () => {
    const dir = `specs/${FEATURE}`;
    const commit = (sha: string, paths?: string[]) => ({
      sha: sha.repeat(20),
      message: `Dispatcher: ${sha}${trailers('dispatcher')}`,
      parents: 1,
      ...(paths === undefined ? {} : { paths }),
    });
    const commits = [
      commit('a1', [`${dir}/events.jsonl`]),
      commit('b2', [`${dir}/.station.json`]),
      commit('c3', [`${dir}/.station.json`, 'src/login.ts']),
      commit('d4'),
      commit('e5', ['.specify/feature.json', `${dir}/events.jsonl`]),
    ];
    expect(untrailered(commits, FEATURE)).toEqual([
      `c3c3c3c3c3c3 Dispatcher: c3: Factory-Role: dispatcher on a commit that changes src/login.ts`,
      `d4d4d4d4d4d4 Dispatcher: d4: Factory-Role: dispatcher on a commit whose changed files are unknown`,
      `e5e5e5e5e5e5 Dispatcher: e5: Factory-Role: dispatcher on a commit that changes .specify/feature.json`,
    ]);
  });

  it('AC-017 (T180, T182): accepts a commit without trailers that changes only the Owner’s answers.md, and only when the Owner signed it', () => {
    const dir = `specs/${FEATURE}`;
    const commit = (sha: string, paths: string[], ownerSigned = true) => ({
      ...{ sha: sha.repeat(20), message: `Answers ${sha}\n`, parents: 1, paths, ownerSigned },
    });
    const commits = [
      commit('a1', [`${dir}/answers.md`]),
      commit('b2', [`${dir}/answers.md`, `${dir}/spec.md`]),
      commit('c3', ['specs/9-other/answers.md']),
      commit('d4', [`${dir}/answers.md`], false),
    ];
    expect(untrailered(commits, FEATURE).map((p) => p.slice(0, 12))).toEqual([
      'b2b2b2b2b2b2',
      'b2b2b2b2b2b2',
      'c3c3c3c3c3c3',
      'c3c3c3c3c3c3',
      'd4d4d4d4d4d4',
      'd4d4d4d4d4d4',
    ]);
  });

  it('AC-017 (T178): a merge needs the trailers unless it is a clean merge of main', () => {
    const merge = (sha: string, over: { cleanMerge?: boolean; message?: string } = {}) => ({
      ...{
        sha: sha.repeat(20),
        message: over.message ?? "Merge remote-tracking branch 'origin/main'\n",
      },
      ...{ parents: 2 },
      ...(over.cleanMerge === undefined ? {} : { cleanMerge: over.cleanMerge }),
    });
    const commits = [
      merge('a1', { cleanMerge: true }),
      merge('b2', { cleanMerge: false }),
      merge('c3'),
      merge('d4', { message: `Merge origin/main, conflicts resolved${trailers()}` }),
    ];

    expect(untrailered(commits, FEATURE)).toEqual([
      "b2b2b2b2b2b2 Merge remote-tracking branch 'origin/main': no Factory-Role: trailer",
      "b2b2b2b2b2b2 Merge remote-tracking branch 'origin/main': no Factory-Item: trailer",
      "c3c3c3c3c3c3 Merge remote-tracking branch 'origin/main': no Factory-Role: trailer",
      "c3c3c3c3c3c3 Merge remote-tracking branch 'origin/main': no Factory-Item: trailer",
    ]);
  });
});

// The item's merge summary (T068, slice 22a-4, AC-094): built from what the merge checks found,
// with every agent-written string shown through visible().
describe('merge summary of a work item (T068, AC-094)', () => {
  const view = (over: Partial<MergeView> = {}): MergeView => ({
    pr: { number: 43, title: 'Add login' },
    diffstat: [
      { path: 'src/auth/login.ts', status: 'added', added: 12, removed: 0 },
      { path: 'tests/integration/login.test.ts', status: 'modified', added: 1, removed: 1 },
    ],
    testFiles: ['tests/integration/login.test.ts'],
    early: { findings: [], problems: [], quarantines: [] },
    weakened: [],
    passing: ['AC-001 signs in', 'unrelated', 'AC-002 shows an error'],
    checked: ['AC-001', 'AC-002'],
    ci: [
      { job: 'build-test', workflow: '.github/workflows/ci.yml', state: 'success' },
      { job: 'size', workflow: '.github/workflows/ci.yml', state: 'success' },
    ].map((j, i) => ({ ...j, failedBefore: i === 0 ? 1 : 0, failedRuns: i === 0 ? 1 : 0 })),
    redGreen: { skipped: false, checked: 2 },
    waivers: [],
    ...over,
  });
  const merge = (over: Partial<MergeView> = {}, files: SummaryFacts['files'] = {}) =>
    facts({
      gate: 'merge',
      kind: 'merge',
      files: {
        spec: SPEC,
        tasks: TASKS,
        verify: VERIFY,
        security: SECURITY,
        events: EVENTS,
        ...files,
      },
      merge: view(over),
    });

  it('lists the diffstat and every changed test file, even one whose counts net to zero', () => {
    const changed = part(text(merge()), PART_TITLES.changed);

    expect(changed).toContain('Pull request #43: Add login');
    expect(changed).toContain('added +12 -0 src/auth/login.ts');
    expect(changed).toContain('modified +1 -1 tests/integration/login.test.ts');
    const tests = changed.indexOf(
      'Changed test files (each listed, even when its counts net to zero):',
    );
    expect(changed[tests + 1]).toBe('tests/integration/login.test.ts');
  });

  it('maps each checked criterion to its tagged passing tests', () => {
    expect(part(text(merge()), PART_TITLES.mapping)).toEqual([
      'AC-001 → AC-001 signs in',
      'AC-002 → AC-002 shows an error',
    ]);
  });

  it('shows each required job with its earlier failed attempts and runs, and red-green', () => {
    const results = part(text(merge()), PART_TITLES.results);

    expect(results).toContain(
      'build-test (.github/workflows/ci.yml): success; 1 earlier attempt failed; 1 earlier run failed',
    );
    expect(results).toContain('size (.github/workflows/ci.yml): success');
    expect(results).toContain('red-green: 2 criteria go from failing to passing');
    const skipped = part(
      text(merge({ redGreen: { skipped: true, files: ['tests/a.test.ts'] } })),
      PART_TITLES.results,
    );
    expect(skipped).toContain('red-green skipped: only test code changed (tests/a.test.ts)');
  });

  it("shows the early warning with each line's covering waiver or none, never as a refusal, and a quarantine as not verified", () => {
    const t = text(
      merge({
        early: {
          findings: [
            {
              message: 'tests/a.test.ts: skipped test "adds"',
              target: 'test:tests/a.test.ts#adds',
            },
            {
              message: 'tests/b.test.ts: removed assertion',
              target: 'test:tests/b.test.ts',
              waiver: 'test:tests/b.test.ts',
            },
          ],
          problems: [],
          quarantines: [12],
        },
      }),
    );
    const changed = part(t, PART_TITLES.changed);

    expect(changed).toContain('tests/a.test.ts: skipped test "adds"; waiver: none');
    expect(changed).toContain('tests/b.test.ts: removed assertion; waiver: test:tests/b.test.ts');
    expect(changed).toContain('quarantined per #12 (not verified)');
  });

  it('lists the weakened findings with their waivers, and the waivers in force', () => {
    const waiver = 'test:tests/a.test.ts#adds';
    const t = text(
      merge({
        weakened: [{ target: waiver, what: 'passed at the base, skipped at the head', waiver }],
        waivers: [waiver],
      }),
    );

    expect(part(t, PART_TITLES.changed)).toContain(
      `${waiver}: passed at the base, skipped at the head; covered by ${waiver}`,
    );
    expect(part(t, PART_TITLES.risks)).toContain(`Waivers in force: ${waiver}`);
  });

  it('shows agent-written text through visible(): titles, file names, test titles and findings', () => {
    const t = text(
      merge({
        pr: { number: 43, title: 'Add‮login' },
        diffstat: [{ path: 'src/\u001b[2Jx.ts', status: 'added', added: 1, removed: 0 }],
        testFiles: ['tests/​x.test.ts'],
        passing: ['AC-001 signs\nin', 'AC-002 ok'],
        early: {
          findings: [{ message: 'tests/x.test.ts: skipped test', target: 'test:tests/x.test.ts' }],
          problems: [],
          quarantines: [],
        },
      }),
    );

    for (const shown of [
      'Pull request #43: Add\\u{202e}login',
      'added +1 -0 src/\\u{1b}[2Jx.ts',
      'tests/\\u{200b}x.test.ts',
      'AC-001 → AC-001 signs\\nin',
      'tests/x.test.ts: skipped\\u{a0}test; waiver: none',
    ])
      expect(t).toContain(shown);
  });

  it('quotes a failing verify report, and lists its open findings under Known risks', () => {
    const report = `${VERIFY.replace('| Review | pass |', '| Review | fail |')}\n- [ ] blocking: SQL built by concatenation\n`;
    const t = text(merge({}, { verify: report }));

    expect(part(t, PART_TITLES.results)).toContain('> reports/verify.md: Review: fail');
    const risks = part(t, PART_TITLES.risks);
    expect(risks).toContain('Open findings:');
    expect(risks).toContain('> SQL built by concatenation');
  });

  it('quotes Security’s scans and findings next to the review, and its open findings as risks (T168)', () => {
    const open = SECURITY.replace(
      '- none',
      '- [ ] blocking: eval at src/a.ts:1: input\u202ereaches eval',
    );
    const t = text(merge({}, { security: open }));

    const results = part(t, PART_TITLES.results);
    const at = results.indexOf(
      'quoted from specs/42-add-login/reports/security.md at 5e6f7a8b9c0d:',
    );
    expect(results.slice(at + 1, at + 4)).toEqual([
      '> - semgrep: none',
      '> - gitleaks: none',
      '> - [ ] blocking: eval at src/a.ts:1: input\\u{202e}reaches eval',
    ]);
    const risks = part(t, PART_TITLES.risks);
    expect(risks).toContain('quoted from specs/42-add-login/reports/security.md at 5e6f7a8b9c0d:');
    expect(risks).toContain('> eval at src/a.ts:1: input\\u{202e}reaches eval');
    const tierOne = { ...merge({}, { security: undefined }), tier: 1 as const };
    expect(part(text(tierOne), PART_TITLES.results)).toContain(
      'reports/security.md: none on the branch',
    );
    expect(part(text(merge()), PART_TITLES.risks)).toContain(
      'Open findings: none in reports/verify.md or reports/security.md',
    );
  });

  it('T179: at tier 2–3 no security report refuses; a stale report names both commits; a current one where it was written', () => {
    const none = buildSummary(merge({}, { security: undefined }));
    expect(none.ok ? [] : none.missing).toEqual([
      'Tests and review: no reports/security.md on claude/42-add-login, which tier 2 needs',
    ]);

    const wrote = 'a'.repeat(40);
    const later = 'b'.repeat(40);
    const stale = buildSummary({
      ...merge({}, { verify: undefined }),
      reports: { verify: { wrote, staleAt: later }, security: { wrote } },
    });
    expect(stale.ok ? [] : stale.missing).toEqual([
      'Tests and review: reports/verify.md written at aaaaaaaaaaaa is stale: bbbbbbbbbbbb came after it, so Verify must run again',
    ]);

    const t = text({ ...merge(), reports: { verify: { wrote }, security: { wrote: later } } });
    expect(part(t, PART_TITLES.results)).toContain(
      'quoted from specs/42-add-login/reports/verify.md written at aaaaaaaaaaaa:',
    );
    expect(part(t, PART_TITLES.results)).toContain(
      'quoted from specs/42-add-login/reports/security.md written at bbbbbbbbbbbb:',
    );
  });

  it('refuses when a required part is missing: no verify report (AC-094)', () => {
    const s = buildSummary(merge({}, { verify: undefined }));

    expect(s.ok).toBe(false);
    expect(s.ok ? [] : s.missing).toContainEqual(expect.stringMatching(/^Tests and review: /));
  });
});

// The merge summary of a Define, log or factory-repository branch (T068, slice 22c): the merge
// result's diffstat against main, CI, and the branch's own check, agent text through visible().
describe('merge summary of a Define, log or factory-repository branch (T068, slice 22c)', () => {
  const MAIN = 'a'.repeat(40);
  const view = (over: Partial<BranchMergeView> = {}): BranchMergeView => ({
    pr: { number: 50, title: 'Define: brief and backlog' },
    branch: 'claude/define',
    rule: 'define',
    head: COMMIT,
    main: MAIN,
    base: MAIN,
    diffstat: [{ path: '.factory/brief.md', status: 'added', added: 20, removed: 0 }],
    ci: [
      {
        ...{ job: 'build-test', workflow: '.github/workflows/ci.yml', state: 'success' },
        ...{ failedBefore: 0, failedRuns: 1 },
      },
    ],
    checks: ['Define output check: complete'],
    ...over,
  });
  const branchMerge = (over: Partial<BranchMergeView> = {}) =>
    facts({
      gate: 'merge',
      kind: 'merge-branch',
      issue: { number: 50, title: 'Define: brief and backlog', body: '', labels: [] },
      branchMerge: view(over),
    });

  it("shows the merge result's diffstat against main, labelled so, CI and the branch's own check", () => {
    const t = text(branchMerge());

    const changed = part(t, PART_TITLES.changed);
    expect(changed).toContain('Pull request #50: Define: brief and backlog');
    expect(changed).toContain(`Branch claude/define at ${COMMIT}, onto main at ${MAIN}`);
    expect(changed).toContain('1 file changed by the merge result against main (what lands):');
    expect(changed).toContain('added +20 -0 .factory/brief.md');
    const results = part(t, PART_TITLES.results);
    expect(results).toContain(
      'build-test (.github/workflows/ci.yml): success; 1 earlier run failed',
    );
    expect(results).toContain('Define output check: complete');
    expect(part(t, PART_TITLES.mapping)).toEqual(['—']);
    expect(part(t, PART_TITLES.usage)).toEqual(['—']);
  });

  it('says under Known risks whether main moved since the branch was cut', () => {
    const still = part(text(branchMerge()), PART_TITLES.risks);
    const base = 'b'.repeat(40);
    const moved = part(text(branchMerge({ base })), PART_TITLES.risks);

    expect(still).toContain('The define rule passes at the checked head and on the merge result');
    expect(still).toContain('Main has not moved since the branch was cut');
    expect(moved).toContain(
      `Main moved since the branch was cut at ${base}: what lands is git's merge of the two, checked above`,
    );
  });

  it('shows agent-written text through visible(): the title, the branch and file names', () => {
    const t = text(
      branchMerge({
        pr: { number: 50, title: 'Define‮ brief' },
        branch: 'owner-​work',
        diffstat: [{ path: 'docs/\u001b[2Jx.md', status: 'added', added: 1, removed: 0 }],
      }),
    );

    for (const shown of [
      'Pull request #50: Define\\u{202e} brief',
      'Branch owner-\\u{200b}work at',
      'added +1 -0 docs/\\u{1b}[2Jx.md',
    ])
      expect(t).toContain(shown);
  });

  it('refuses when the branch check has nothing to show', () => {
    const s = buildSummary(branchMerge({ checks: [], ci: [] }));

    expect(s.ok ? [] : s.missing).toContainEqual(expect.stringMatching(/^Tests and review: /));
  });
});

describe('deploy summary (T069, AC-095, slice 23c-1b)', () => {
  const MAIN = 'a'.repeat(40);
  const SINCE = 'b'.repeat(40);
  const MERGE = 'c'.repeat(40);
  const view = (over: Partial<DeployView> = {}): DeployView => ({
    ...{ main: MAIN, since: SINCE, commits: 3 },
    items: [{ issue: 7, title: 'Add login', merge: MERGE, branch: 'claude/7-add-login', tier: 2 }],
    others: [{ commit: 'd'.repeat(40), value: 'factory-log' }],
    ci: [
      {
        ...{ job: 'build-test', workflow: '.github/workflows/ci.yml', state: 'success' },
        ...{ failedBefore: 1, failedRuns: 0 },
      },
    ],
    rollback: [
      {
        issue: 7,
        notes: [
          {
            path: '.factory/releases/2026-10-14.md',
            source: 'origin/claude/factory-log at dddddddddddd, not merged',
            steps: ['Run factory deploy at the previous commit.', 'Drop the sessions table.'],
          },
        ],
      },
    ],
    ...over,
  });
  const deploy = (deploy: DeployView | undefined) =>
    facts({
      ...{ gate: 'deployed', kind: 'deploy', commit: MAIN, deploy },
      ...{ tier: undefined, branch: undefined, files: undefined },
      issue: { number: 1, title: 'Owner inbox', body: '', labels: [] },
    });

  it("shows the commits and items since the last deploy, CI on main's head, the re-verified tiers and each item's rollback steps", () => {
    const t = text(deploy(view()));

    expect(t).toContain(`Approval summary for #1 (deployed) at ${MAIN}:`);
    expect(part(t, PART_TITLES.changed)).toEqual([
      `Main at ${MAIN}, since the last deploy at ${SINCE}`,
      "3 commits on main's verified first-parent history",
      'Items merged:',
      `#7 merged in ${MERGE.slice(0, 12)} from claude/7-add-login`,
      'quoted from issue #7 (its title, issue text):',
      '> Add login',
      `Other merges: factory-log in ${'d'.repeat(12)}`,
    ]);
    expect(part(t, PART_TITLES.mapping)).toEqual(['—']);
    expect(part(t, PART_TITLES.results)).toEqual([
      "CI on main's head (GitHub Actions workflow runs):",
      'build-test (.github/workflows/ci.yml): success; 1 earlier attempt failed',
      "Approvals re-verified with the key lists at main's head:",
      '#7: tier 2',
    ]);
    expect(part(t, PART_TITLES.usage)).toEqual(['unavailable (telemetry missing)']);
    expect(part(t, PART_TITLES.risks)).toEqual([
      'Rollback steps for #7:',
      'quoted from .factory/releases/2026-10-14.md on origin/claude/factory-log at dddddddddddd, not merged:',
      '> Run factory deploy at the previous commit.',
      '> Drop the sessions table.',
    ]);
  });

  it('shows a first deploy from the baseline, and with no item shipped needs no release note', () => {
    const t = text(deploy(view({ since: undefined, items: [], others: [], rollback: [] })));

    expect(part(t, PART_TITLES.changed)).toEqual([
      `Main at ${MAIN}, since the baseline (no deploy yet)`,
      "3 commits on main's verified first-parent history",
      'Items merged: none',
      'Other merges: none',
    ]);
    expect(part(t, PART_TITLES.results)).toContain('No item to re-verify');
    expect(part(t, PART_TITLES.risks)).toEqual([
      'No item merged since the last deploy: no release note needed',
    ]);
  });

  it('shows issue titles, branch names and rollback steps through visible(), labelled as quoted text', () => {
    const t = text(
      deploy(
        view({
          items: [
            { issue: 7, title: 'Add\u202e login', merge: MERGE, branch: 'claude/7-a', tier: 1 },
          ],
          rollback: [
            {
              issue: 7,
              notes: [{ path: 'r\u200b.md', source: 'main at x', steps: ['undo\u001b[2J'] }],
            },
          ],
        }),
      ),
    );

    for (const shown of [
      '> Add\\u{202e} login',
      'quoted from r\\u{200b}.md on main at x:',
      '> undo\\u{1b}[2J',
    ])
      expect(t).toContain(shown);
  });

  it('refuses when the deploy checks were not passed in', () => {
    const s = buildSummary(deploy(undefined));

    expect(s.ok ? [] : s.missing.map((m) => m.split(':')[0])).toEqual([
      PART_TITLES.changed,
      PART_TITLES.results,
      PART_TITLES.risks,
    ]);
  });
});

describe('deploy health summary (T069, T160, slice 23d)', () => {
  const MAIN = 'a'.repeat(40);
  const NONCE = '0123456789abcdef0123456789abcdef';
  const health = (over: Partial<HealthView> = {}): HealthView => ({
    ...{ main: MAIN, release: `${MAIN}-20261015T090000Z` },
    deployed: { id: '1001', nonce: NONCE },
    answer: 'GET /health answered 200 {"status":"ok"}',
    rollback: [
      {
        issue: 7,
        notes: [{ path: '.factory/releases/7.md', source: 'main at x', steps: ['Undo\u001b'] }],
      },
    ],
    ...over,
  });
  const healthFacts = (view: HealthView | undefined) =>
    facts({
      ...{ gate: 'deploy-healthy', commit: MAIN, health: view },
      ...{ tier: undefined, branch: undefined, files: undefined },
      issue: { number: 1, title: 'Owner inbox', body: '', labels: [] },
    });

  it("shows the deployed record it confirms, the health check's result and the rollback steps; nothing else applies", () => {
    const t = text(healthFacts(health()));

    expect(t).toContain(`Approval summary for #1 (deploy-healthy) at ${MAIN}:`);
    expect(part(t, PART_TITLES.changed)).toEqual([
      `The deployed record it confirms: comment 1001 on the inbox, nonce ${NONCE}`,
      `Main at ${MAIN}, running as release ${MAIN}-20261015T090000Z`,
    ]);
    expect(part(t, PART_TITLES.mapping)).toEqual(['—']);
    expect(part(t, PART_TITLES.results)).toEqual([
      'Health check, run on this laptop: GET /health answered 200 {"status":"ok"}',
    ]);
    expect(part(t, PART_TITLES.usage)).toEqual(['—']);
    expect(part(t, PART_TITLES.risks)).toEqual([
      'Rollback steps for #7:',
      'quoted from .factory/releases/7.md on main at x:',
      '> Undo\\u{1b}',
    ]);
  });

  it('refuses when the health check was not passed in', () => {
    const s = buildSummary(healthFacts(undefined));

    expect(s.ok ? [] : s.missing.map((m) => m.split(':')[0])).toEqual([
      PART_TITLES.changed,
      PART_TITLES.results,
      PART_TITLES.risks,
    ]);
  });
});
