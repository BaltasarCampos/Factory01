import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runStop } from '../../src/hooks/stop.js';
import { checkPlan } from '../../src/stations/checks/plan.js';
import { checkSpec, criterionLines } from '../../src/stations/checks/spec.js';
import { makeRepo, type Files } from '../helpers/git-repo.js';

const SPEC = `# Feature Specification: Add login

## Problem *(mandatory)*

Visitors cannot sign in, so every saved link is public.

## Non-goals *(mandatory)*

- Social login.

## Affected areas *(mandatory)*

- \`src/auth/\` and the login page.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sign in (Priority: P1)

**Acceptance Scenarios**:

1. **AC-001** — **Given** a registered user, **When** they sign in with the right password, **Then** they see their links.
2. **AC-002** — **Given** a registered user, **When** they give a wrong password, **Then** they see an error.

### Edge Cases

- **AC-003** — **Given** five failed attempts, **When** the user tries again, **Then** they wait one minute.
`;

const TIER1_SPEC = `# Feature Specification: Fix a typo

**Summary (tier 1 one-line spec)**: Fix the home page heading; a test reads it.
**Problem**: The home page says "Wellcome".
**Non-goals**: No other copy changes.
**Affected areas**: \`src/home.ts\`.

1. **AC-001** — **Given** the home page, **When** it loads, **Then** the heading reads "Welcome".
`;

const PLAN = (estimate = '~350') => `# Implementation Plan: Add login

## Plan Usage Budget

| Item | Value |
|------|-------|
| Model sessions planned (per station) | Build 1 · Review 1 |
| Estimated changed lines | ${estimate} |

## Constitution Check

| # | Principle | Check | Status |
|---|-----------|-------|--------|
| I | Owner Holds Intent | No scope beyond the spec | ✅ |
| III | Test-Gated Delivery | Every AC mapped | ✅ |
`;

const TASKS = `# Tasks: Add login

## Phase 1: Setup

- [ ] T001 Add the auth folder · Files: src/auth/index.ts

## Phase 3: User Story 1 - Sign in (Priority: P1)

### Tests for User Story 1 (MANDATORY — write first, run, see them FAIL) ⚠️

- [ ] T002 [P] [US1] Integration test for sign-in (AC-001, AC-002) · Files: tests/integration/login.test.ts
- [ ] T003 [P] [US1] Unit test for the lockout (AC-003) · Files: tests/unit/lockout.test.ts

### Implementation for User Story 1

- [X] T004 [US1] Sign-in handler and lockout · Files: src/auth/login.ts, src/auth/lockout.ts
`;

const why = (missing: string[] | undefined) => (missing ?? []).join('\n');
const drop = (text: string, heading: string) =>
  text.replace(new RegExp(`## ${heading} \\*\\(mandatory\\)\\*\\n\\n[^\\n]+\\n\\n`), '');

describe('Specify output check (AC-010)', () => {
  it('AC-010: a spec with problem, testable ACs, non-goals and affected areas is complete', () => {
    expect(checkSpec(SPEC)).toEqual({
      complete: true,
      missing: [],
      acs: ['AC-001', 'AC-002', 'AC-003'],
    });
  });

  it('AC-010: a tier 1 one-line spec may give each section as one labelled line', () => {
    expect(checkSpec(TIER1_SPEC)).toMatchObject({ complete: true, acs: ['AC-001'] });
  });

  it.each(['Problem', 'Non-goals', 'Affected areas'])('AC-010: refuses a spec with no %s', (s) => {
    const result = checkSpec(drop(SPEC, s));
    expect(result.complete).toBe(false);
    expect(why(result.missing)).toMatch(new RegExp(`spec.md: no ${s} section`));
  });

  it.each([
    ['empty', '## Non-goals *(mandatory)*\n\n## Affected'],
    [
      'a template placeholder',
      '## Non-goals *(mandatory)*\n\n- [What this item does not do]\n\n## Affected',
    ],
    ['only a comment', '## Non-goals *(mandatory)*\n\n<!-- later -->\n\n## Affected'],
  ])('AC-010: refuses a section that is %s', (_name, section) => {
    const text = SPEC.replace(
      /## Non-goals \*\(mandatory\)\*\n\n- Social login\.\n\n## Affected/,
      section,
    );
    expect(why(checkSpec(text).missing)).toMatch(/spec.md: the Non-goals section is empty/);
  });

  it('AC-010: refuses a spec with no acceptance criteria', () => {
    const text = SPEC.replace(/\*\*AC-\d+\*\*/g, 'Scenario');
    expect(why(checkSpec(text).missing)).toMatch(/no acceptance criteria/);
  });

  it('AC-010: every acceptance criterion must be testable as Given/When/Then', () => {
    const text = SPEC.replace(/(AC-002\*\* — )\*\*Given\*\*[^\n]+/, '$1Errors are friendly.');
    expect(why(checkSpec(text).missing)).toMatch(/AC-002 has no Given\/When\/Then/);
  });

  it('AC-010: an acceptance criterion ID is defined once', () => {
    const text = SPEC.replace('**AC-003**', '**AC-001**');
    expect(why(checkSpec(text).missing)).toMatch(/AC-001 is defined twice/);
  });

  it('AC-010: a criterion mentioned in prose is not a definition', () => {
    const text = `${SPEC}\nSee AC-009 in the old spec.\n`;
    expect(checkSpec(text).acs).toEqual(['AC-001', 'AC-002', 'AC-003']);
  });

  it('AC-010: the factory spec template has the three sections and fails until it is filled in', () => {
    const path = fileURLToPath(new URL('../../factory/speckit/spec-template.md', import.meta.url));
    const template = readFileSync(path, 'utf8');
    for (const s of ['Problem', 'Non-goals', 'Affected areas'])
      expect(template).toMatch(new RegExp(`^## ${s} \\*\\(mandatory\\)\\*$`, 'm'));
    expect(why(checkSpec(template).missing)).toMatch(/the Problem section is empty/);
  });
});

describe('criterion lines (AC-097)', () => {
  const add = (where: string, line: string) => SPEC.replace(where, `${where}\n${line}`);

  it('AC-097: a Problem sentence starting "When users…" is not a criterion line', () => {
    const text = add(
      'Visitors cannot sign in, so every saved link is public.',
      'When users log out, nothing changes.',
    );
    expect(checkSpec(text)).toMatchObject({ complete: true, acs: ['AC-001', 'AC-002', 'AC-003'] });
  });

  it.each([
    ['a bold When line', '**When** the session expires, the user is asked to sign in again.'],
    ['a Given/When line', 'Given a signed-in user, when the session expires, they sign in again.'],
    ['a list item under Edge Cases', '- Five failed attempts lock the account.'],
    ['a list item under Acceptance Scenarios', '3. The login page loads.'],
  ])('AC-097: %s without an ID fails', (_name, line) => {
    const where = line.startsWith('3.')
      ? '**Then** they see an error.'
      : '**Then** they wait one minute.';
    const result = checkSpec(add(where, line));
    expect(result.complete).toBe(false);
    expect(why(result.missing)).toMatch(
      /spec\.md:\d+: criterion line without a leading \*\*AC-###\*\*/,
    );
  });

  it('AC-097: a criterion line starts with exactly one ID, matched as a whole word', () => {
    const two = SPEC.replace('**AC-002** —', '**AC-002** **AC-004** —');
    expect(why(checkSpec(two).missing)).toMatch(/criterion line with 2 \*\*AC-###\*\* IDs/);
    const glued = SPEC.replace('**AC-002** —', '**AC-002x** —');
    expect(why(checkSpec(glued).missing)).toMatch(/criterion line without a leading/);
  });

  it('AC-097: the criterion lines are read by one parser, with their IDs', () => {
    expect(criterionLines(SPEC).map((c) => c.id)).toEqual(['AC-001', 'AC-002', 'AC-003']);
    expect(criterionLines('# S\n\n**Given** x, **When** y, **Then** z.\n')).toEqual([
      { line: 3, problem: 'criterion line without a leading **AC-###** ID' },
    ]);
  });
});

describe('Plan output check (AC-011)', () => {
  const plan = (over: { spec?: string; plan?: string; tasks?: string; sizeLimit?: number } = {}) =>
    checkPlan({ spec: SPEC, plan: PLAN(), tasks: TASKS, sizeLimit: 400, ...over });

  it('AC-011: a plan under the size limit with mapped, test-first tasks is complete', () => {
    expect(plan()).toEqual({ complete: true, missing: [] });
  });

  it('AC-011: every task lists the files it may touch', () => {
    const tasks = TASKS.replace(' · Files: src/auth/login.ts, src/auth/lockout.ts', '');
    expect(why(plan({ tasks }).missing)).toMatch(/T004 has no · Files: list/);
    const empty = TASKS.replace('src/auth/login.ts, src/auth/lockout.ts', '');
    expect(why(plan({ tasks: empty }).missing)).toMatch(/T004 has no · Files: list/);
  });

  it('AC-011: refuses tasks.md without tasks', () => {
    expect(why(plan({ tasks: '# Tasks\n' }).missing)).toMatch(/tasks.md: no tasks/);
  });

  it.each([
    ['~450', 400, /estimates 450 changed lines; the limit is 400/],
    ['1,200', 400, /estimates 1200 changed lines; the limit is 400/],
    ['~350', 300, /estimates 350 changed lines; the limit is 300/],
  ])('AC-011: refuses an estimate of %s over a limit of %d', (estimate, sizeLimit, reason) => {
    expect(why(plan({ plan: PLAN(estimate), sizeLimit }).missing)).toMatch(reason);
  });

  it('AC-011: refuses a plan without an estimate of changed lines', () => {
    const text = PLAN().replace(/\| Estimated changed lines[^\n]+\n/, '');
    expect(why(plan({ plan: text }).missing)).toMatch(/plan.md: no estimated changed lines/);
  });

  it('AC-011: refuses a plan whose Constitution Check fails or is absent', () => {
    const failing = `${PLAN()}| V | Frugal by Design | Paid API | ❌ |\n`;
    expect(why(plan({ plan: failing }).missing)).toMatch(/Constitution Check has a failing row/);
    const absent = PLAN().replace(/## Constitution Check[\s\S]*$/, '');
    expect(why(plan({ plan: absent }).missing)).toMatch(/plan.md: no Constitution Check/);
  });

  it('AC-011: every acceptance criterion maps to a test task, not only to an implementation task', () => {
    const tasks = TASKS.replace(' (AC-003)', '').replace('and lockout', 'and lockout (AC-003)');
    expect(why(plan({ tasks }).missing)).toMatch(/AC-003 has no test task/);
  });

  it('AC-011: test tasks come before implementation tasks in every phase', () => {
    const tasks = `${TASKS}\n### Tests for the lockout\n\n- [ ] T005 Lockout timing test (AC-003) · Files: tests/unit/timing.test.ts\n`;
    expect(why(plan({ tasks }).missing)).toMatch(
      /T005 is a test task after implementation task T004/,
    );
  });

  it('AC-011: a test task in a later phase may follow an earlier phase’s implementation', () => {
    const tasks = `${TASKS}\n## Phase 4: User Story 2\n\n### Tests for User Story 2\n\n- [ ] T005 Logout test (AC-001) · Files: tests/unit/logout.test.ts\n\n### Implementation for User Story 2\n\n- [ ] T006 Logout · Files: src/auth/logout.ts\n`;
    expect(plan({ tasks })).toEqual({ complete: true, missing: [] });
  });
});

describe('factory hook stop runs the Specify, Plan and Verify checks (AC-063)', () => {
  const FEATURE = 'specs/42-add-login';
  const CONFIG = `factory_release: v1.0.0@${'a'.repeat(40)}\nagents: local\nprofile: typescript\nrepo: owner/project\ninbox_issue: 1\n`;
  const role = (name: string) =>
    `---\nname: ${name}\nmodel: sonnet\ntools: Read, Write\nversion: 1\n---\nYou are the ${name}.\n`;
  const VERIFY = `| Check | Result |\n|---|---|\n${['CI', 'Coverage', 'SAST', 'SCA', 'Secrets', 'Licences', 'Review'].map((c) => `| ${c} | pass |`).join('\n')}\n`;

  /** An item branch whose station manifest names `station` and `agent`, with `files` committed. */
  function stationRun(station: number, agent: string, files: Files, config = CONFIG) {
    const r = makeRepo({
      files: { '.factory/config': config, [`.claude/agents/${agent}.md`]: role(agent) },
    });
    r.checkout('claude/42-add-login', { create: true });
    const manifest = { item: 42, station, role: agent, branch: 'claude/42-add-login' };
    r.commit(
      {
        '.specify/feature.json': JSON.stringify({ feature_directory: FEATURE }),
        [`${FEATURE}/.station.json`]: JSON.stringify(manifest),
        ...files,
      },
      'station output',
    );
    const input = { session_id: 's1', cwd: r.path, hook_event_name: 'Stop', agent_type: agent };
    return { r, stop: () => runStop(input, { cwd: r.path, now: () => new Date() }) };
  }

  it('AC-063: Specify may stop once a complete spec.md is committed', async () => {
    const { stop } = stationRun(2, 'spec', { [`${FEATURE}/spec.md`]: SPEC });
    expect(await stop()).toEqual({ block: false });
  });

  it('AC-063: a spec.md written but not committed does not count', async () => {
    const { r, stop } = stationRun(2, 'spec', {});
    writeFileSync(join(r.path, FEATURE, 'spec.md'), SPEC);
    const result = await stop();
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/specs\/42-add-login\/spec.md: not committed/);
  });

  it('AC-063: Plan is held to the size limit in the project config', async () => {
    const files = {
      [`${FEATURE}/spec.md`]: SPEC,
      [`${FEATURE}/plan.md`]: PLAN(),
      [`${FEATURE}/tasks.md`]: TASKS,
    };
    expect(await stationRun(3, 'planner', files).stop()).toEqual({ block: false });
    const lowered = stationRun(3, 'planner', files, `${CONFIG}size_limit_lines: 300\n`);
    expect((await lowered.stop()).reason).toMatch(/estimates 350 changed lines; the limit is 300/);
  });

  it('AC-063: Verify may stop only with a passing verify report', async () => {
    const report = `${FEATURE}/reports/verify.md`;
    expect(await stationRun(5, 'reviewer', { [report]: VERIFY }).stop()).toEqual({ block: false });
    const failing = stationRun(5, 'reviewer', {
      [report]: VERIFY.replace('| SCA | pass |', '| SCA | fail |'),
    });
    expect((await failing.stop()).reason).toMatch(/SCA: fail/);
  });
});
