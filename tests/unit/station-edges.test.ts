import { describe, expect, it } from 'vitest';
import type { Verdict } from '../../src/approvals/verify.js';
import { nextTransition, type Evidence } from '../../src/dispatcher/transitions.js';
import { runStop } from '../../src/hooks/stop.js';
import {
  checkSplit,
  conflictFailure,
  splitFailure,
  weakenedTests,
  type DiffFile,
} from '../../src/stations/edges.js';
import { makeRepo } from '../helpers/git-repo.js';

const BRANCH = 'claude/42-add-login';
const verified = (gate: 'approved' | 'spec-approved'): Verdict => ({
  ok: true,
  record: {
    repo: 'owner/project',
    issue: 42,
    gate,
    tier: 2,
    branch: BRANCH,
    ...(gate === 'spec-approved' ? { spec_sha: 'a'.repeat(40) } : {}),
    timestamp: '2026-10-01T09:12:44Z',
    nonce: '9f2c1e0a7b4d4e8f8a1b2c3d4e5f6a7b',
  },
  comment: { id: 'c1', createdAt: '2026-10-01T09:12:44Z', body: '' },
});
const GATED: Evidence = {
  rotationPending: false,
  historySigned: true,
  owner: {
    approved: verified('approved'),
    'spec-approved': verified('spec-approved'),
    waiver: { ok: false, kind: 'missing', reason: 'no label' },
  },
};
const RUNNING = { line: false, stations: new Set<never>() };

describe('Builder split (AC-057)', () => {
  it('AC-057: request_split sends the item back to Plan with the task and reason', () => {
    const failure = splitFailure({ task: 'T007', reason: 'size limit' });
    expect(failure).toEqual({ station: 3, reason: 'T007 returned to Plan: size limit' });
    expect(nextTransition({ state: 'building' }, { ...GATED, failure }, RUNNING)).toEqual({
      ok: true,
      to: 'spec-approved',
      reason: 'gate failed: T007 returned to Plan: size limit',
    });
  });

  const pr = (number: number, headRefName: string, title: string) => ({
    number,
    headRefName,
    title,
  });
  const issue = (number: number, body: string) => ({ number, body });

  it('AC-057: Plan files new work items, each marked split-of the item', () => {
    const result = checkSplit({
      item: 42,
      branch: BRANCH,
      issues: [
        issue(50, 'Lockout timer\n\n<!-- split-of #42 -->'),
        issue(51, '<!-- split-of #42 -->\nRemember me'),
        issue(52, 'Unrelated'),
      ],
      prs: [pr(8, BRANCH, '#42 Add login')],
    });
    expect(result).toEqual({ complete: true, missing: [], newItems: [50, 51] });
  });

  it('AC-057: a split with no new work item, or with a second PR for the item, is incomplete', () => {
    expect(checkSplit({ item: 42, branch: BRANCH, issues: [], prs: [] })).toEqual({
      complete: false,
      missing: ['no new work item marked <!-- split-of #42 -->'],
      newItems: [],
    });
    const twice = checkSplit({
      item: 42,
      branch: BRANCH,
      issues: [issue(50, '<!-- split-of #42 -->')],
      prs: [
        pr(8, BRANCH, '#42 Add login'),
        pr(9, 'claude/42-add-login-part-2', '#42 Add login, part 2'),
      ],
    });
    expect(twice.missing).toEqual(['#42 has 2 pull requests (#8, #9); a split opens none']);
  });
});

describe('Integrate conflicts (AC-058)', () => {
  const REPORT = `# Integrate report\n\n## Conflicts\n\n- src/auth/login.ts: main renamed the session helper the handler calls\n- tests/unit/login.test.ts: fixture format changed\n\n## Rebase\n\n- onto 1c9d0e5\n`;

  it('AC-058: a conflict report sends the item back to Build, never on to releasing', () => {
    const failure = conflictFailure(REPORT);
    expect(failure).toEqual({
      station: 4,
      reason:
        'rebase conflicts need a behaviour change: src/auth/login.ts: main renamed the session helper the handler calls; tests/unit/login.test.ts: fixture format changed',
    });
    if (failure === undefined) throw new Error('no failure');
    // Even with a signed merge on main, a conflict report never moves the item forward.
    const decision = nextTransition(
      { state: 'integrating' },
      { ...GATED, failure, ownerMerge: true },
      RUNNING,
    );
    expect(decision).toMatchObject({ ok: true, to: 'building' });
  });

  it('AC-058: a report with no conflicts, or "none", routes nowhere', () => {
    expect(conflictFailure('# Integrate report\n\n## Rebase\n\n- clean\n')).toBeUndefined();
    expect(conflictFailure('## Conflicts\n\n- none\n')).toBeUndefined();
    expect(conflictFailure('## Conflicts\n\n<!-- - [path]: [why] -->\n')).toBeUndefined();
  });
});

const file = (path: string, added: string[], removed: string[] = []): DiffFile => ({
  path,
  status: 'modified',
  added,
  removed,
});
const TEST = 'tests/unit/login.test.ts';

describe('flaky, skipped and weakened tests (AC-061)', () => {
  it('AC-061: a fix that keeps every test and assertion passes', () => {
    const diff = [
      file(
        TEST,
        ["  it('locks out', async () => {", '    expect(await t()).toBe(3);'],
        ["  it('locks out', () => {", '    expect(t()).toBe(3);'],
      ),
      file('src/auth/login.ts', [], ['  expect(x);', '  it.skip(']),
    ];
    expect(weakenedTests(diff, { waived: false, openIssues: new Set() })).toEqual({
      ok: true,
      findings: [],
      problems: [],
      quarantines: [],
    });
  });

  it('AC-061: skipping, focusing, retrying or deleting tests fails without an Owner waiver', () => {
    const diff: DiffFile[] = [
      file(
        TEST,
        ["  it.skip('locks out', () => {", "  test.todo('remember me');"],
        ["  it('locks out', () => {"],
      ),
      file('tests/unit/a.test.ts', ["  it.only('runs alone', () => {"]),
      file(
        'tests/unit/b.test.ts',
        ["  it('retries', { retry: 3 }, () => {"],
        ["  it('retries', () => {"],
      ),
      {
        path: 'tests/unit/gone.test.ts',
        status: 'deleted',
        added: [],
        removed: ["it('x', () => {"],
      },
      file(
        'tests/unit/c.test.ts',
        [],
        ["  it('drops', () => {", '    expect(a).toBe(1);', '  });'],
      ),
    ];
    const result = weakenedTests(diff, { waived: false, openIssues: new Set() });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      `${TEST}: skips a test: it.skip('locks out', () => {`,
      `${TEST}: skips a test: test.todo('remember me');`,
      "tests/unit/a.test.ts: focuses a test, skipping the others: it.only('runs alone', () => {",
      "tests/unit/b.test.ts: retries a test: it('retries', { retry: 3 }, () => {",
      'tests/unit/gone.test.ts: deletes the test file',
      'tests/unit/c.test.ts: removes 1 test block',
      'tests/unit/c.test.ts: removes 1 assertion',
    ]);
  });

  it('AC-061: a quarantined flaky test needs both the Owner waiver and an open issue', () => {
    const quarantined = [
      file(
        TEST,
        ["  it.skip('locks out', () => { // quarantine #61: fails on slow CI"],
        ["  it('locks out', () => {"],
      ),
    ];
    const open = new Set([61]);
    expect(weakenedTests(quarantined, { waived: false, openIssues: open })).toMatchObject({
      ok: false,
      problems: [],
      quarantines: [61],
    });
    expect(weakenedTests(quarantined, { waived: true, openIssues: open }).ok).toBe(true);

    const closed = weakenedTests(quarantined, { waived: true, openIssues: new Set() });
    expect(closed.ok).toBe(false);
    expect(closed.problems).toEqual([`${TEST}: quarantine names #61, which is not an open issue`]);

    const bare = weakenedTests([file(TEST, ["  it.skip('locks out', () => {"])], {
      waived: true,
      openIssues: open,
    });
    expect(bare.ok).toBe(false);
    expect(bare.problems).toEqual([
      `${TEST}: skip without a quarantine issue (\`quarantine #<n>\`): it.skip('locks out', () => {`,
    ]);
  });

  it('AC-061: the quarantine note may sit on the line above the skip', () => {
    const diff = [
      file(TEST, ['  // quarantine #61: flaky on CI', "  it.skip('locks out', () => {"]),
    ];
    expect(weakenedTests(diff, { waived: true, openIssues: new Set([61]) })).toMatchObject({
      ok: true,
      quarantines: [61],
    });
  });
});

describe('stop check (AC-063)', () => {
  it('AC-063: a session whose output file is missing keeps going instead of ending', async () => {
    const r = makeRepo({
      files: {
        '.factory/config': `factory_release: v1.0.0@${'a'.repeat(40)}\nagents: local\nrepo: owner/project\ninbox_issue: 1\n`,
        '.claude/agents/reviewer.md': '---\nname: reviewer\nmodel: sonnet\nversion: 1\n---\n',
      },
    });
    r.checkout(BRANCH, { create: true });
    const manifest = { item: 42, station: 5, role: 'reviewer', branch: BRANCH };
    r.commit(
      {
        '.specify/feature.json': JSON.stringify({ feature_directory: 'specs/42-add-login' }),
        'specs/42-add-login/.station.json': JSON.stringify(manifest),
      },
      'manifest',
    );
    const input = {
      session_id: 's1',
      cwd: r.path,
      hook_event_name: 'Stop',
      agent_type: 'reviewer',
    };
    const stop = () => runStop(input, { cwd: r.path, now: () => new Date() });
    expect(await stop()).toEqual({
      block: true,
      reason:
        'station verify output is incomplete: specs/42-add-login/reports/verify.md: not committed',
    });
    // Only after one forced continuation may the session end; nothing advances without the file.
    expect(
      await runStop({ ...input, stop_hook_active: true }, { cwd: r.path, now: () => new Date() }),
    ).toEqual({ block: false });
    expect((await stop()).block).toBe(true);
  });
});
