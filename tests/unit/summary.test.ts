import { describe, expect, it } from 'vitest';
import { trace, traceBack, untrailered, type TraceInput } from '../../src/events/trace.js';
import {
  buildSummary,
  GATE_PARTS,
  PART_TITLES,
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
      `quoted from specs/42-add-login/spec.md at ${COMMIT.slice(0, 12)}:`,
      '> Lockout logic could block real users.',
    ]);
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
  it('AC-094: a merge summary is not refused by the code-gate check, and quotes the verify report', () => {
    const report = `${VERIFY.replace('| SCA | pass |', '| SCA | fail |')}\n- [ ] blocking: SQL built by concatenation\n`;
    const s = buildSummary(
      facts({ kind: 'merge', files: { spec: SPEC, tasks: TASKS, verify: report } }),
    );
    if (!s.ok) throw new Error(`refused: ${s.missing.join('; ')}`);
    expect(part(s.text, 'Tests and review')).toEqual([
      `quoted from specs/42-add-login/reports/verify.md at ${COMMIT.slice(0, 12)}:`,
      '> reports/verify.md: SCA: fail',
      '> reports/verify.md: unresolved blocking finding: SQL built by concatenation',
    ]);
    expect(part(s.text, 'Spec mapping')).toEqual(['AC-001 → T002', 'AC-002 → no test task yet']);
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
