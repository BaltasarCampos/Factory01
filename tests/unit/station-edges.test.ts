import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Verdict } from '../../src/approvals/verify.js';
import { nextTransition, type Evidence } from '../../src/dispatcher/transitions.js';
import { runStop } from '../../src/hooks/stop.js';
import {
  checkSplit,
  conflictFailure,
  isTestCode,
  isTestFile,
  loadTestConfig,
  RELEASE_TEST_PATHS,
  TEST_CONFIG,
  splitFailure,
  testHelpers,
  weakenedTests,
  type DiffFile,
} from '../../src/stations/edges.js';
import { makeRepo } from '../helpers/git-repo.js';
import { tempDir } from '../helpers/keys.js';

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

  it("AC-058: before the Owner's merge, a conflict report sends the item back to Build", () => {
    const failure = conflictFailure(REPORT);
    expect(failure).toEqual({
      station: 4,
      reason:
        'rebase conflicts need a behaviour change: src/auth/login.ts: main renamed the session helper the handler calls; tests/unit/login.test.ts: fixture format changed',
    });
    if (failure === undefined) throw new Error('no failure');
    // Before the Owner's merge, the item goes back to Build.
    expect(nextTransition({ state: 'integrating' }, { ...GATED, failure }, RUNNING)).toMatchObject({
      ok: true,
      to: 'building',
    });
  });

  it('AC-058: after the Owner-signed merge, a conflict moves the item on to releasing with an alert', () => {
    const failure = conflictFailure(REPORT);
    if (failure === undefined) throw new Error('no failure');
    const merged = { ...GATED, failure, ownerMerge: true };
    const decision = nextTransition({ state: 'integrating' }, merged, RUNNING);
    expect(decision).toMatchObject({ ok: true, to: 'releasing' });
    expect(decision.alert).toMatch(
      /^failed a gate after the Owner's merge: rebase conflicts .*; file a follow-up issue$/,
    );
    // Found while already releasing: it stays there, still with the alert.
    const there = nextTransition({ state: 'releasing' }, merged, RUNNING);
    expect(there).toMatchObject({ ok: false });
    expect(there.alert).toMatch(/after the Owner's merge/);
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
const NONE = {
  waivers: new Set<string>(),
  openIssues: new Set<number>(),
  helpers: new Set<string>(),
};
const messages = (r: { findings: { message: string }[] }) => r.findings.map((f) => f.message);

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
    expect(weakenedTests(diff, NONE)).toEqual({
      ok: true,
      findings: [],
      problems: [],
      quarantines: [],
    });
  });

  it('AC-061: each skipped, focused, retried or deleted test names the waiver target that covers it', () => {
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
    const result = weakenedTests(diff, NONE);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => [f.message, f.target, f.covered])).toEqual([
      [`${TEST}: skips a test: it.skip('locks out', () => {`, `test:${TEST}#locks out`, false],
      [`${TEST}: skips a test: test.todo('remember me');`, `test:${TEST}#remember me`, false],
      [
        "tests/unit/a.test.ts: focuses a test, skipping the others: it.only('runs alone', () => {",
        'test:tests/unit/a.test.ts#runs alone',
        false,
      ],
      [
        "tests/unit/b.test.ts: retries a test: it('retries', { retry: 3 }, () => {",
        'test:tests/unit/b.test.ts#retries',
        false,
      ],
      ['tests/unit/gone.test.ts: deletes the test file', 'test:tests/unit/gone.test.ts', false],
      [
        "tests/unit/c.test.ts: removes test block 'drops'",
        'test:tests/unit/c.test.ts#drops',
        false,
      ],
      ['tests/unit/c.test.ts: removes 1 assertion', 'test:tests/unit/c.test.ts', false],
    ]);
  });

  it('AC-061: one waiver covers only its own test; a file-wide target covers the whole file', () => {
    const diff = [
      file(TEST, ["  it.only('locks out', () => {", "  it('remember me', { retry: 2 }, () => {"]),
      file('tests/unit/c.test.ts', [], ['    expect(a).toBe(1);']),
    ];
    const one = weakenedTests(diff, { ...NONE, waivers: new Set([`test:${TEST}#locks out`]) });
    expect(one.ok).toBe(false);
    expect(one.findings.map((f) => f.covered)).toEqual([true, false, false]);

    const all = weakenedTests(diff, {
      ...NONE,
      waivers: new Set([`test:${TEST}`, 'test:tests/unit/c.test.ts']),
    });
    expect(all.ok).toBe(true);
    // A removed assertion inside an unchanged test cannot name its test: only the file-wide target covers it.
    const titled = weakenedTests([diff[1] as DiffFile], {
      ...NONE,
      waivers: new Set(['test:tests/unit/c.test.ts#drops']),
    });
    expect(titled.ok).toBe(false);
  });

  it('AC-061: a quarantined flaky test needs both its waiver and an open issue', () => {
    const quarantined = [
      file(
        TEST,
        ["  it.skip('locks out', () => { // quarantine #61: fails on slow CI"],
        ["  it('locks out', () => {"],
      ),
    ];
    const open = new Set([61]);
    const waived = new Set([`test:${TEST}#locks out`]);
    expect(weakenedTests(quarantined, { ...NONE, openIssues: open })).toMatchObject({
      ok: false,
      problems: [],
      quarantines: [61],
    });
    expect(weakenedTests(quarantined, { ...NONE, waivers: waived, openIssues: open }).ok).toBe(
      true,
    );

    const closed = weakenedTests(quarantined, { ...NONE, waivers: waived });
    expect(closed.ok).toBe(false);
    expect(closed.problems).toEqual([`${TEST}: quarantine names #61, which is not an open issue`]);

    const bare = weakenedTests([file(TEST, ["  it.skip('locks out', () => {"])], {
      ...NONE,
      waivers: waived,
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
    const options = {
      ...NONE,
      waivers: new Set([`test:${TEST}#locks out`]),
      openIssues: new Set([61]),
    };
    expect(weakenedTests(diff, options)).toMatchObject({ ok: true, quarantines: [61] });
  });

  const flagged = (line: string) => {
    const result = weakenedTests([file(TEST, [line])], NONE);
    return result.findings.map((f) => [f.message, f.target]);
  };

  it('AC-061: it.skipIf(...) is a skip', () => {
    expect(flagged("  it.skipIf(isCI)('locks out', () => {")).toEqual([
      [`${TEST}: skips a test: it.skipIf(isCI)('locks out', () => {`, `test:${TEST}`],
    ]);
  });

  it('AC-061: describe.skipIf(...) is a skip', () => {
    expect(flagged("  describe.skipIf(true)('login', () => {")[0]?.[0]).toBe(
      `${TEST}: skips a test: describe.skipIf(true)('login', () => {`,
    );
  });

  it('AC-061: it.runIf(false) is a skip', () => {
    expect(flagged("  it.runIf(false)('locks out', () => {")[0]?.[0]).toBe(
      `${TEST}: skips a test: it.runIf(false)('locks out', () => {`,
    );
  });

  it('AC-061: ctx.skip() inside a test is a skip', () => {
    expect(flagged('    ctx.skip();')).toEqual([
      [`${TEST}: skips a test: ctx.skip();`, `test:${TEST}`],
    ]);
  });

  it('AC-061: test.fails(...) inverts a test', () => {
    expect(flagged("  test.fails('locks out', () => {")).toEqual([
      [
        `${TEST}: inverts a test (it passes when it fails): test.fails('locks out', () => {`,
        `test:${TEST}#locks out`,
      ],
    ]);
  });

  it('AC-061: changed setup files and test helpers need a file-wide waiver', () => {
    const setup = 'tests/setup.ts';
    const config = { ...TEST_CONFIG, setupFiles: [setup], globalSetup: [] };
    const diff = [
      file(setup, ['process.env.TZ = "UTC";']),
      file('tests/helpers/db.ts', ['export const seed = 2;'], ['export const seed = 1;']),
      file('src/auth/login.ts', ['export const x = 1;']),
    ];
    const result = weakenedTests(diff, {
      ...NONE,
      helpers: new Set(['tests/helpers/db.ts']),
      config,
    });
    expect(messages(result)).toEqual([
      `${setup}: changes a test setup file`,
      'tests/helpers/db.ts: changes a test helper',
    ]);
    expect(result.findings.map((f) => f.target)).toEqual([
      `test:${setup}`,
      'test:tests/helpers/db.ts',
    ]);
  });

  it('AC-061: helpers are test-path files with no it/test call, and files only tests or helpers import', () => {
    const head = new Map([
      [
        'tests/login.test.ts',
        "import { seed } from './helpers/db.js';\nimport { fixture } from './shared.test.js';\nimport { login } from '../src/login.js';\nit('a', () => {});\n",
      ],
      ['tests/shared.test.ts', 'export const fixture = 1;\n'],
      [
        'tests/helpers/db.ts',
        "import { fake } from '../../lib/fake-clock.js';\nexport const seed = 1;\n",
      ],
      ['lib/fake-clock.ts', 'export const fake = 1;\n'],
      ['src/login.ts', 'export const login = 1;\n'],
      ['src/server.ts', "import { login } from './login.js';\n"],
    ]);
    // src/login.ts is imported by a test but also by src/server.ts: production code, not a helper.
    // lib/fake-clock.ts is imported only by a helper, so it is a helper too (second level).
    expect([...testHelpers(head, head)].sort()).toEqual([
      'lib/fake-clock.ts',
      'tests/helpers/db.ts',
      'tests/shared.test.ts',
    ]);
  });

  it('AC-061: moving assertion logic two levels deep still makes it a helper', () => {
    const head = new Map([
      ['tests/a.test.ts', "import { check } from '../lib/one.js';\nit('a', () => check());\n"],
      ['lib/one.ts', "import { deep } from './two.js';\nexport const check = deep;\n"],
      ['lib/two.ts', "import { leaf } from './three.js';\nexport const deep = leaf;\n"],
      ['lib/three.ts', 'export const leaf = () => expect(1).toBe(1);\n'],
    ]);
    expect([...testHelpers(head, head)].sort()).toEqual([
      'lib/one.ts',
      'lib/three.ts',
      'lib/two.ts',
    ]);
  });

  it('AC-061: helpers that import each other are still helpers', () => {
    const head = new Map([
      ['tests/a.test.ts', "import { one } from '../lib/one.js';\nit('a', () => one());\n"],
      ['lib/one.ts', "import { two } from './two.js';\nexport const one = two;\n"],
      ['lib/two.ts', "import { one } from './one.js';\nexport const two = () => one;\n"],
      ['src/app.ts', "import { x } from './x.js';\n"],
      ['src/x.ts', "import { y } from './y.js';\nexport const x = 1;\n"],
      ['src/y.ts', "import { x } from './x.js';\nexport const y = 1;\n"],
    ]);
    expect([...testHelpers(head, head)].sort()).toEqual(['lib/one.ts', 'lib/two.ts']);
  });

  it('AC-061: a helper deleted at head is still found from the base, and its deletion needs a waiver', () => {
    const base = new Map([
      ['tests/a.test.ts', "import { seed } from '../lib/seed.js';\nit('a', () => seed());\n"],
      ['lib/seed.ts', 'export const seed = () => expect(1).toBe(1);\n'],
    ]);
    const head = new Map([['tests/a.test.ts', "it('a', () => {});\n"]]);
    const helpers = testHelpers(base, head);
    expect([...helpers]).toEqual(['lib/seed.ts']);
    const gone: DiffFile = {
      path: 'lib/seed.ts',
      status: 'deleted',
      added: [],
      removed: ['export const seed = () => expect(1).toBe(1);'],
    };
    const result = weakenedTests([gone], { ...NONE, helpers });
    expect(result.ok).toBe(false);
    expect(messages(result)).toEqual(['lib/seed.ts: deletes a test helper']);
  });

  it('AC-061: a new module not wired in yet is not a helper, even though only its new test imports it', () => {
    const base = new Map([['tests/a.test.ts', "it('a', () => expect(1).toBe(1));\n"]]);
    const head = new Map([
      ...base,
      [
        'tests/parse.test.ts',
        "import { parse } from '../src/parse.js';\nit('p', () => parse());\n",
      ],
      ['src/parse.ts', 'export const parse = () => 1;\n'],
    ]);
    expect([...testHelpers(base, head)]).toEqual([]);
  });

  it('AC-061: an existing test switched to a new no-op helper is flagged through its removed assertions', () => {
    const base = new Map([
      ['tests/a.test.ts', "it('a', () => {\n  expect(sum(1, 1)).toBe(2);\n});\n"],
    ]);
    const head = new Map([
      [
        'tests/a.test.ts',
        "import { check } from './check.js';\nit('a', () => {\n  check();\n});\n",
      ],
      ['tests/check.ts', 'export const check = () => {};\n'],
    ]);
    const helpers = testHelpers(base, head);
    expect([...helpers]).toEqual([]);
    const diff: DiffFile[] = [
      file(
        'tests/a.test.ts',
        ["import { check } from './check.js';", '  check();'],
        ['  expect(sum(1, 1)).toBe(2);'],
      ),
      {
        path: 'tests/check.ts',
        status: 'added',
        added: ['export const check = () => {};'],
        removed: [],
      },
    ];
    const result = weakenedTests(diff, { ...NONE, helpers });
    expect(result.ok).toBe(false);
    expect(messages(result)).toEqual(['tests/a.test.ts: removes 1 assertion']);
  });

  it('AC-061: test paths come from the release’s test-paths.json, never a local constant or the project', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const shipped = join(root, 'factory/profiles/typescript/ci/test-paths.json');
    expect(RELEASE_TEST_PATHS).toBe(shipped);
    expect(TEST_CONFIG).toEqual(JSON.parse(readFileSync(shipped, 'utf8')));
    expect(TEST_CONFIG.include).toEqual(['tests/**/*.test.ts']);
    expect(TEST_CONFIG.paths).toEqual(['tests/**']);
  });

  it('AC-061: test code is everything under tests/, at any depth; test files only *.test.ts there', () => {
    expect(isTestCode('tests/helpers/git/repo.ts')).toBe(true);
    expect(isTestCode('src/tests/x.ts')).toBe(false);
    expect(isTestFile('tests/helpers/git/repo.ts')).toBe(false);
    expect(isTestFile('tests/unit/a/b.test.ts')).toBe(true);
  });

  it('AC-061: a test-paths file with anything but the five pattern lists is refused', () => {
    const dir = tempDir();
    const file = join(dir, 'test-paths.json');
    writeFileSync(file, JSON.stringify({ ...TEST_CONFIG, include: 'tests/**' }));
    expect(() => loadTestConfig(file)).toThrow(/include must be a list/);
    writeFileSync(file, JSON.stringify({ ...TEST_CONFIG, retry: 3 }));
    expect(() => loadTestConfig(file)).toThrow(/unknown keys retry/);
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
