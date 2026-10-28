import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dispatcherMessage } from '../../src/dispatcher/branch.js';
import { runStop } from '../../src/hooks/stop.js';
import { buildStopCheck } from '../../src/stations/checks/build.js';
import { checkPlan } from '../../src/stations/checks/plan.js';
import { parseAnswers } from '../../src/stations/checks/questions.js';
import { checkSpec, criterionLines, specStopCheck } from '../../src/stations/checks/spec.js';
import { makeRepo, type Files, type TestRepo } from '../helpers/git-repo.js';
import { recordSession, SESSION_ID } from '../helpers/session.js';

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

## Assumptions

- None

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
    const path = fileURLToPath(
      new URL('../../factory/specify/templates/spec-template.md', import.meta.url),
    );
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
    ['a Given/When line', 'Given a signed-in user, When the session expires, they sign in again.'],
    ['a list item under Edge Cases', '- Five failed attempts lock the account.'],
    ['a list item under Acceptance Scenarios', '3. The login page loads.'],
    [
      'a lowercase given/when/then list item under Acceptance Scenarios',
      '3. given a user, when they sign in, then they see links.',
    ],
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

  it('AC-097: lowercase "when … then" prose outside the criteria sections is not a criterion line', () => {
    const text = add(
      'Visitors cannot sign in, so every saved link is public.',
      'when a link is saved, then it stays public.',
    );
    expect(checkSpec(text).complete).toBe(true);
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

describe('questions in the Specify and Plan checks (T180, AC-033)', () => {
  const asking = (text: string, ...questions: string[]) =>
    text.replace(/^## Problem/m, `## Clarifications\n\n${questions.join('\n')}\n\n## Problem`);
  const plan = (over: { spec?: string; plan?: string; answers?: string } = {}) =>
    checkPlan({
      ...{ spec: SPEC, plan: PLAN(), tasks: TASKS, sizeLimit: 400, ...over },
      answers: parseAnswers(over.answers ?? 'A1. B\nA2. SQLite\n'),
    });
  const planAsking = (...questions: string[]) =>
    PLAN().replace(/^/, `## Clarifications\n\n${questions.join('\n')}\n\n`);

  it('AC-033: an open question is a waiting stop when nothing else is missing', () => {
    expect(checkSpec(asking(SPEC, '- Q1: Which sign-in?'))).toEqual({
      complete: false,
      waiting: true,
      missing: ["spec.md: Q1 waits for the Owner's answer"],
      acs: ['AC-001', 'AC-002', 'AC-003'],
    });
    const answered = asking(SPEC, '- Q1: Which sign-in? → A: B');
    expect(checkSpec(answered, parseAnswers('A1. B\n')).complete).toBe(true);
  });

  it('AC-033 (T182): an applied answer with no A1 line from the Owner waits for the Owner', () => {
    const result = checkSpec(asking(SPEC, '- Q1: Which sign-in? → A: B'), new Map());
    expect(result).toMatchObject({
      complete: false,
      waiting: true,
      missing: ["spec.md: Q1 waits for the Owner's answer"],
    });
  });

  it('AC-033 (T182): an applied answer that differs from the Owner’s A1 waits for the command to apply it', () => {
    const result = checkSpec(asking(SPEC, '- Q1: Which sign-in? → A: B'), parseAnswers('A1. C\n'));
    expect(result).toMatchObject({
      complete: false,
      missing: ["spec.md: Q1 has the Owner's answer to apply"],
    });
    expect(result.waiting).toBeUndefined();
  });

  it('T182: refuses a question line with two → A:', () => {
    const text = asking(SPEC, '- Q1: Which sign-in? → A: A → A: B');
    expect(why(checkSpec(text, parseAnswers('A1. B\n')).missing)).toMatch(
      /spec.md: Q1 has more than one → A:/,
    );
  });

  it('an applied option’s text matches the Owner’s letter, and the letter matches the text', () => {
    const q = (applied: string) =>
      asking(SPEC, `- Q1: Which sign-in? → A: ${applied}`, '  - Options: A) Email B) A magic link');
    expect(checkSpec(q('A magic link'), parseAnswers('A1. B\n')).complete).toBe(true);
    expect(checkSpec(q('B'), parseAnswers('A1. b) a magic link.\n')).complete).toBe(true);
    expect(checkSpec(q('A magic link'), parseAnswers('A1. A\n')).complete).toBe(false);
  });

  it('AC-033: a question needing an Owner action keeps the spec waiting', () => {
    const text = asking(SPEC, '- Q1: Who may invite? → A: admins → Owner action: tier raise');
    expect(checkSpec(text)).toMatchObject({ complete: false, waiting: true });
  });

  it('AC-033: open questions and another gap are not a waiting stop', () => {
    const result = checkSpec(asking(drop(SPEC, 'Problem'), '- Q1: Which sign-in?'));
    expect(result.waiting).toBeUndefined();
    expect(result.complete).toBe(false);
  });

  it('refuses a new question once a follow-up exists, and the refusal is not a waiting stop', () => {
    const text = asking(
      SPEC,
      '- Q1: Which? → A: B',
      '- Q2 (follow-up): Then? → A: C',
      '- Q3: And?',
    );
    const result = checkSpec(text, parseAnswers('A1. B\nA2. C\n'));
    expect(result.waiting).toBeUndefined();
    expect(why(result.missing)).toMatch(/Q3 is asked after the follow-up round/);
  });

  it('AC-033: Plan’s questions wait the same way, numbered on from spec.md’s', () => {
    const spec = asking(SPEC, '- Q1: Which sign-in? → A: B');
    expect(plan({ spec, plan: planAsking('- Q2: Which database?'), answers: 'A1. B\n' })).toEqual({
      complete: false,
      waiting: true,
      missing: ["plan.md: Q2 waits for the Owner's answer"],
    });
    expect(plan({ spec, plan: planAsking('- Q2: Which database? → A: SQLite') }).complete).toBe(
      true,
    );
    const applied = planAsking('- Q2: Which database? → A: Postgres');
    expect(why(plan({ spec, plan: applied }).missing)).toMatch(
      /plan.md: Q2 has the Owner's answer to apply/,
    );
    expect(
      why(plan({ spec, plan: planAsking('- Q1: Which database? → A: SQLite') }).missing),
    ).toMatch(/plan.md: Q1 is numbered within spec.md's questions; number on from Q2/);
  });

  it('the stop checks read the committed files: a waiting spec', () => {
    const repo = makeRepo({
      files: { 'specs/42-add-login/spec.md': asking(SPEC, '- Q1: Which?') },
    });
    repo.checkout('claude/42-add-login', { create: true });
    expect(specStopCheck(repo.path)).toMatchObject({ complete: false, waiting: true });
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

  // The dispatcher turns a Build task's files into the session's Edit rules (T061): `.` would
  // allow the whole clone, so Plan's own check refuses any path that is not plain.
  it.each([
    ...['.', './', 'src/', 'src/.', 'src//x.ts', './src/x.ts', 'src/a b.ts', 'src/a).ts'],
    ...['src/a!.ts', 'src\\x.ts', 'src/#x.ts', '**', '/etc/passwd', '~/x', 'src/../x', 'src/*.ts'],
  ])('AC-011: refuses a task listing %j, which is no plain path', (file) => {
    const tasks = TASKS.replace(
      'src/auth/login.ts, src/auth/lockout.ts',
      `src/auth/login.ts, ${file}`,
    );
    expect(why(plan({ tasks }).missing)).toContain(
      `tasks.md: T004 lists ${JSON.stringify(file)}, not a plain path in the repository`,
    );
  });

  it('AC-011: accepts plain task paths', () => {
    const files = 'src/login.ts, tests/a-b_c.test.ts, @types/x.d.ts';
    const tasks = TASKS.replace('src/auth/login.ts, src/auth/lockout.ts', files);
    expect(plan({ tasks })).toEqual({ complete: true, missing: [] });
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

  it('T173: refuses a ## Clarifications with no question, and a plan without ## Assumptions, as the template has them', () => {
    const asksNothing = `## Clarifications\n\n- Q[n]: [a full question]\n\n${PLAN()}`;
    expect(why(plan({ plan: asksNothing }).missing)).toMatch(
      /plan\.md: ## Clarifications has no question; delete it when Plan asks nothing/,
    );
    const none = PLAN().replace('## Assumptions\n\n- None\n\n', '');
    expect(why(plan({ plan: none }).missing)).toMatch(
      /plan\.md: no ## Assumptions; write None when Plan took no default/,
    );
    const empty = PLAN().replace('- None\n', '<!-- defaults -->\n');
    expect(why(plan({ plan: empty }).missing)).toMatch(/plan\.md: ## Assumptions is empty/);
    const placeholder = PLAN().replace('- None', '- [The default taken, and why it is low-impact]');
    expect(why(plan({ plan: placeholder }).missing)).toMatch(
      /plan\.md: ## Assumptions still holds the template's placeholder/,
    );
    // Only the template's own line: a bracketed default or a reference link passes.
    for (const line of ['- [Default] Postgres, see [R2]', '- [ADR-0007][adr]'])
      expect(plan({ plan: PLAN().replace('- None', line) }).missing, line).toEqual([]);
    expect(plan().missing).toEqual([]);
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
  const VERIFY = '| Check | Result |\n|---|---|\n| Review | pass |\n';
  const SECURITY = '## Scans\n\n- semgrep: none\n\n## Findings\n\n- none\n';

  /** An item branch whose station manifest names `station` and `agent`, with `files` committed. */
  function stationRun(station: number, agent: string, files: Files, config = CONFIG) {
    const r = makeRepo({
      files: { '.factory/config': config, [`.claude/agents/${agent}.md`]: role(agent) },
    });
    r.checkout('claude/42-add-login', { create: true });
    const manifest = { item: 42, station, role: agent, branch: 'claude/42-add-login' };
    r.commit(
      {
        [`${FEATURE}/.station.json`]: JSON.stringify(manifest),
        ...files,
      },
      'station output',
    );
    const { env } = recordSession({ role: agent, station, clone: r.path });
    const input = { session_id: SESSION_ID, cwd: r.path, hook_event_name: 'Stop' };
    return { r, stop: () => runStop(input, { cwd: r.path, now: () => new Date(), env }) };
  }

  it('AC-063: Specify may stop once a complete spec.md is committed', async () => {
    const { stop } = stationRun(2, 'spec', { [`${FEATURE}/spec.md`]: SPEC });
    expect(await stop()).toEqual({ block: false });
  });

  it('T170: the stop check reads the folder of the checked-out branch, ignoring .specify/feature.json', async () => {
    const other = { '.specify/feature.json': JSON.stringify({ feature_directory: 'specs/9-x' }) };
    const { stop } = stationRun(2, 'spec', { ...other, [`${FEATURE}/spec.md`]: SPEC });
    expect(await stop()).toEqual({ block: false });
  });

  it('T170: off a work-item branch the stop hook refuses', async () => {
    const { r, stop } = stationRun(2, 'spec', { [`${FEATURE}/spec.md`]: SPEC });
    r.checkout('main');
    await expect(stop()).rejects.toThrow(/not on a work-item branch \(on main\)/);
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
      [report]: VERIFY.replace('| Review | pass |', '| Review | fail |'),
    });
    expect((await failing.stop()).reason).toMatch(/Review: fail/);
  });

  it('AC-063: Security at Verify may stop only with its own report, never on the review (T168)', async () => {
    const security = `${FEATURE}/reports/security.md`;
    const review = `${FEATURE}/reports/verify.md`;
    const done = stationRun(5, 'security', { [security]: SECURITY });
    expect(await done.stop()).toEqual({ block: false });
    const reviewOnly = stationRun(5, 'security', { [review]: VERIFY });
    expect((await reviewOnly.stop()).reason).toMatch(/reports\/security.md/);
    const open = stationRun(5, 'security', {
      [security]: SECURITY.replace(
        '- none',
        '- [ ] blocking: eval at src/a.ts:1: input reaches eval',
      ),
    });
    expect((await open.stop()).reason).toMatch(/unresolved blocking finding: eval at src\/a.ts:1/);
    expect((await stationRun(5, 'reviewer', { [security]: SECURITY }).stop()).block).toBe(true);
  });
});

describe("Build's stop check for a task session (T174)", () => {
  const FEATURE = 'specs/42-add-login';
  const BRANCH = 'claude/42-add-login';
  const MANIFEST = `${FEATURE}/.station.json`;
  const TRAILERS = { 'Factory-Role': 'builder', 'Factory-Item': '42-add-login' };
  const TASK = { task: 'T007', files: ['src/login.ts', 'tests/login.test.ts'] };
  const WORK = { 'src/login.ts': 'b\n', 'tests/login.test.ts': 't\n' };
  const CONFIG = `factory_release: v1.0.0@${'a'.repeat(40)}\nagents: local\nprofile: typescript\nrepo: owner/project\ninbox_issue: 1\n`;
  const ROLE = '---\nname: builder\nmodel: sonnet\ntools: Read, Write\nversion: 1\n---\nBuild.\n';

  /** The item branch on origin, its tip the dispatcher's Build manifest commit. */
  function issued(task: Record<string, unknown> = TASK): TestRepo {
    const r = makeRepo({
      files: {
        ...{ '.factory/config': CONFIG, '.claude/agents/builder.md': ROLE, 'src/login.ts': 'a\n' },
        [`${FEATURE}/tasks.md`]: '- [ ] T007 Login · Files: src/login.ts, tests/login.test.ts\n',
      },
    });
    r.checkout(BRANCH, { create: true });
    const manifest = { item: 42, station: 4, role: 'builder', branch: BRANCH, ...task };
    r.commit(
      { [MANIFEST]: JSON.stringify({ ...manifest, issued_at: '2026-10-22T09:00:00Z' }) },
      dispatcherMessage('station 4 (builder) manifest', '42-add-login'),
    );
    r.push();
    return r;
  }
  /** The Builder's commit of `files`, pushed; returns it. */
  const build = (r: TestRepo, files: Files = WORK, trailers: Record<string, string> = TRAILERS) => {
    const sha = r.commit(files, 'Add login', { trailers });
    r.push();
    return sha;
  };

  it('T174: the Builder may stop once its commits on the manifest commit are pushed', async () => {
    const r = issued();
    build(r);
    build(r, { 'tests/login.test.ts': 't2\n' });
    const { env } = recordSession({ role: 'builder', station: 4, clone: r.path });
    const input = { session_id: SESSION_ID, cwd: r.path, hook_event_name: 'Stop' };

    expect(await runStop(input, { cwd: r.path, now: () => new Date(), env })).toEqual({
      block: false,
    });
  });

  it.each<[string, (r: TestRepo) => void, RegExp]>([
    ['no commit after the manifest', () => undefined, /no commit after the dispatcher's manifest/],
    ['work not pushed', (r) => r.commit(WORK, 'Add login', { trailers: TRAILERS }), /not pushed/],
    [
      'origin unreadable',
      (r) => {
        build(r);
        return r.git(['remote', 'set-url', 'origin', join(r.path, 'gone.git')]);
      },
      /not pushed: origin's claude\/42-add-login is unreadable \(git ls-remote failed/,
    ],
    ['no trailers', (r) => build(r, WORK, {}), /no Factory-Role: builder.*no Factory-Item/],
    [
      "another item's trailer",
      (r) => build(r, WORK, { ...TRAILERS, 'Factory-Item': '7-other' }),
      /Factory-Item: 7-other is not 42-add-login/,
    ],
    [
      'a file outside the task',
      (r) => build(r, { ...WORK, 'src/admin.ts': 'x\n' }),
      /src\/admin\.ts: not in T007's files/,
    ],
    [
      'tasks.md ticked',
      (r) => build(r, { [`${FEATURE}/tasks.md`]: '- [X] T007 Login\n' }),
      /tasks\.md: the factory ticks your task/,
    ],
    [
      'a .station.json the Builder wrote',
      (r) => build(r, { ...WORK, [MANIFEST]: '{}\n' }),
      /the last commit to change specs\/42-add-login\/\.station\.json is not the dispatcher's/,
    ],
    [
      'the manifest commit rewritten away',
      (r) => {
        r.git(['reset', '-q', '--hard', 'HEAD~1']);
        r.commit(WORK, 'Add login', { trailers: TRAILERS });
        r.push(undefined, { force: true });
      },
      /no dispatcher manifest commit/,
    ],
    [
      'a merge',
      (r) => {
        r.git(['checkout', '-q', '-b', 'side', 'main']);
        r.commit({ 'src/login.ts': 'side\n' }, 'Side', { trailers: TRAILERS });
        r.checkout(BRANCH);
        const message = 'Merge side\n\nFactory-Role: builder\nFactory-Item: 42-add-login';
        r.git(['merge', '-q', '--no-ff', '--no-gpg-sign', '-m', message, 'side']);
        r.push();
      },
      /is a merge; a task session only adds commits/,
    ],
  ])('T174: the Builder may not stop with %s', (_name, act, reason) => {
    const r = issued();
    act(r);
    const result = buildStopCheck(r.path);

    expect(result.complete).toBe(false);
    expect(result.missing?.join('\n')).toMatch(reason);
  });
});

describe("Build's stop check for a conflict session (T174)", () => {
  const BRANCH = 'claude/42-add-login';
  const MANIFEST = 'specs/42-add-login/.station.json';
  const TRAILERS = { 'Factory-Role': 'builder', 'Factory-Item': '42-add-login' };

  /** The branch after Integrate's conflict: the conflict manifest on origin, and main moved. */
  function conflicted(): TestRepo {
    const r = makeRepo({ files: { 'src/login.ts': 'a\n', 'src/other.ts': 'o\n' } });
    r.checkout(BRANCH, { create: true });
    r.commit({ 'src/login.ts': 'branch\n' }, 'Login', { trailers: TRAILERS });
    const manifest = { item: 42, station: 4, role: 'builder', branch: BRANCH };
    r.commit(
      { [MANIFEST]: JSON.stringify({ ...manifest, files: ['src/login.ts'] }) },
      dispatcherMessage('station 4 (builder) manifest', '42-add-login'),
    );
    r.push();
    r.checkout('main');
    r.commit({ 'src/login.ts': 'main\n', 'src/other.ts': 'o2\n' }, 'Main moved');
    r.push('main');
    r.checkout(BRANCH);
    return r;
  }
  /** The Builder merges `theirs`, resolves with `files`, commits with `trailers` and pushes. */
  const resolve = (
    r: TestRepo,
    {
      files = {},
      trailers = TRAILERS,
      theirs = 'origin/main',
    }: Partial<{
      files: Files;
      trailers: Record<string, string>;
      theirs: string;
    }> = {},
  ) => {
    try {
      r.git(['merge', '-q', '--no-gpg-sign', theirs]);
    } catch {
      // The conflict Integrate reported; resolved below.
    }
    r.commit({ 'src/login.ts': 'both\n', ...files }, 'Merge main', { trailers });
    r.push();
  };

  it('T174: the Builder may stop once its merge of main, resolving only the listed files, is pushed', () => {
    const r = conflicted();
    resolve(r);

    expect(buildStopCheck(r.path)).toEqual({ complete: true });
  });

  it.each<[string, (r: TestRepo) => unknown, RegExp]>([
    [
      'a file beyond the merge and the list',
      (r) => {
        resolve(r, { files: { 'src/other.ts': 'mine\n' } });
      },
      /src\/other\.ts: changed beyond git's own merge, and not a file reports\/integrate\.md lists/,
    ],
    [
      'a merge of something not on main',
      (r) => {
        r.git(['checkout', '-q', '-b', 'side', 'main~1']);
        r.commit({ 'src/login.ts': 'side\n' }, 'Side');
        r.checkout(BRANCH);
        resolve(r, { theirs: 'side' });
      },
      /merges [0-9a-f]{12}, which is not on origin\/main/,
    ],
    [
      'no merge',
      (r) => {
        r.commit({ 'src/login.ts': 'both\n' }, 'Resolve', { trailers: TRAILERS });
        r.push();
      },
      /does not merge main: merge origin\/main first/,
    ],
    [
      'a merge without trailers',
      (r) => {
        resolve(r, { trailers: {} });
      },
      /no Factory-Role: builder trailer/,
    ],
  ])('T174: the Builder may not stop with %s', (_name, act, reason) => {
    const r = conflicted();
    act(r);

    expect(buildStopCheck(r.path).missing?.join('\n')).toMatch(reason);
  });
});
