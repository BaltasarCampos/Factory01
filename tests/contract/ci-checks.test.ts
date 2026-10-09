// T051: the Verify report check (slice 14) and `factory ci coverage`, `size` and `ac-map`
// (slice 18b, contracts/ci-checks.md). The CI checks read the diff through the safe diff only,
// and their limits from the release and main's config, never from the pull request.
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/commands.js';
import { checkVerifyReport, VERIFY_CHECKS } from '../../src/stations/checks/verify.js';
import { gitEnv, makeRepo, type Files, type TestRepo } from '../helpers/git-repo.js';

const ROWS = {
  CI: 'pass | run 812 green on 3f9a0c1',
  Coverage: 'pass | 94.2% of changed lines',
  SAST: 'pass | semgrep: 0 new findings',
  SCA: 'pass | npm audit: 0 at or above high',
  Secrets: 'pass | gitleaks: none',
  Licences: 'pass | all on the allowed list',
  Review: 'pass | 2 findings, both resolved',
};

function report(
  rows: Record<string, string> = ROWS,
  findings = '- [x] blocking: lockout never resets (fixed in 9c1e2d0)\n- non-blocking: rename `tries`\n',
) {
  const table = Object.entries(rows)
    .map(([check, rest]) => `| ${check} | ${rest} |`)
    .join('\n');
  return `# Verify report: #42 Add login\n\n| Check | Result | Evidence |\n|-------|--------|----------|\n${table}\n\n## Blocking findings\n\n${findings}`;
}

const why = (text: string) => checkVerifyReport(text).missing.join('\n');

describe('Verify report check (AC-013)', () => {
  it('AC-013: a report with every check passing and blocking findings resolved lets the item move on', () => {
    expect(checkVerifyReport(report())).toEqual({
      complete: true,
      missing: [],
      checksPass: true,
      findingsResolved: true,
    });
  });

  it('AC-013: the report must list CI, coverage, SAST, SCA, secrets, licences and review', () => {
    expect([...VERIFY_CHECKS]).toEqual([
      'CI',
      'Coverage',
      'SAST',
      'SCA',
      'Secrets',
      'Licences',
      'Review',
    ]);
  });

  it.each(Object.keys(ROWS))('AC-013: a report without %s blocks the item', (check) => {
    const rows = Object.fromEntries(Object.entries(ROWS).filter(([c]) => c !== check));
    const result = checkVerifyReport(report(rows));
    expect(result).toMatchObject({ complete: false, checksPass: false });
    expect(why(report(rows))).toMatch(new RegExp(`reports/verify.md: no ${check} line`));
  });

  it.each(Object.keys(ROWS))('AC-013: a failing %s line blocks the item', (check) => {
    const rows = { ...ROWS, [check]: 'fail | see the job log' };
    expect(checkVerifyReport(report(rows))).toMatchObject({ complete: false, checksPass: false });
    expect(why(report(rows))).toMatch(new RegExp(`${check}: fail`));
  });

  it('AC-013: anything other than pass counts as failing', () => {
    const rows = { ...ROWS, SAST: 'skipped | semgrep was not run' };
    expect(why(report(rows))).toMatch(/SAST: skipped/);
  });

  it('AC-013: a check listed twice with different results counts as failing', () => {
    const text = report().replace('| Review |', '| Coverage | fail | 88% |\n| Review |');
    expect(why(text)).toMatch(/Coverage: listed 2 times/);
  });

  it('AC-013: an unresolved blocking review finding blocks the item even when every check passes', () => {
    const text = report(ROWS, '- [ ] blocking: passwords are logged\n- [x] blocking: lockout\n');
    expect(checkVerifyReport(text)).toMatchObject({
      complete: false,
      checksPass: true,
      findingsResolved: false,
    });
    expect(why(text)).toMatch(/unresolved blocking finding: passwords are logged/);
  });

  it('AC-013: check names are matched without regard to case, and Licenses is accepted', () => {
    const rows = Object.fromEntries(
      Object.entries(ROWS).map(([c, r]) => [c === 'Licences' ? 'Licenses' : c.toLowerCase(), r]),
    );
    expect(checkVerifyReport(report(rows)).complete).toBe(true);
  });
});

// ---------------------------------------------------------------- factory ci (slice 18b)

const CONFIG = `factory_release: v1.0.0@${'a'.repeat(40)}\nrepo: owner/project\ninbox_issue: 1\n`;
const BRANCH = 'claude/42-add-login';

/** main with `.factory/config` (plus `config` lines) pushed, and the item branch checked out. */
function project(config = '', files: Files = {}) {
  const repo = makeRepo({
    files: { '.factory/config': CONFIG + config, 'README.md': 'r\n', ...files },
  });
  const base = repo.revParse('HEAD');
  repo.checkout(BRANCH, { create: true });
  return { repo, base };
}

const numbered = (n: number, prefix = 'line') =>
  Array.from(
    { length: n },
    (_, i) => `export const ${prefix}${String(i + 1)} = ${String(i)};\n`,
  ).join('');

async function ci(repo: TestRepo, args: string[]) {
  const out: string[] = [];
  const code = await runCli(['ci', ...args], {
    stdout: { write: (s: string) => void out.push(s) },
    stderr: { write: (s: string) => void out.push(s) },
    env: gitEnv,
    stdinIsTTY: false,
    cwd: repo.path,
    unreadAlerts: () => Promise.reject(new Error('ci must not read the inbox')),
  });
  return { code, output: out.join('') };
}

/** An lcov report for `file`, with the given hit count per line number. */
function lcov(repo: TestRepo, records: Record<string, Record<number, number>>, absolute = false) {
  const text = Object.entries(records)
    .map(([file, lines]) => {
      const da = Object.entries(lines).map(([n, hits]) => `DA:${n},${String(hits)}`);
      return ['TN:', `SF:${absolute ? join(repo.path, file) : file}`, ...da, 'end_of_record'].join(
        '\n',
      );
    })
    .join('\n');
  mkdirSync(join(repo.path, 'coverage'), { recursive: true });
  writeFileSync(join(repo.path, 'coverage', 'lcov.info'), `${text}\n`);
}

/** Hits for lines 1..n, the first `covered` of them hit. */
const hits = (n: number, covered: number) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, i < covered ? 1 : 0]));

describe('factory ci coverage (QG-3, AC-013)', () => {
  it.each([
    [899, 1, '89.9% fails'],
    [900, 0, '90% passes'],
  ])(
    'AC-013: %i of 1000 changed lines covered: %s against the release floor of 90',
    async (covered, code) => {
      const { repo, base } = project();
      const head = repo.commit({ 'src/login.ts': numbered(1000) }, 'login');
      lcov(repo, { 'src/login.ts': hits(1000, covered) });

      const r = await ci(repo, ['coverage', base, head]);

      expect(r.code).toBe(code);
      expect(r.output).toContain(`${String(covered)} of 1000 changed lines covered`);
    },
  );

  it('AC-013: the threshold is the stricter of the floor and main’s coverage_min; the branch’s config is not read', async () => {
    const { repo, base } = project('coverage_min: 95\n');
    const head = repo.commit(
      { 'src/login.ts': numbered(100), '.factory/config': `${CONFIG}coverage_min: 91\n` },
      'login',
    );
    lcov(repo, { 'src/login.ts': hits(100, 94) });
    const r = await ci(repo, ['coverage', base, head]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('threshold 95%');
  });

  it('AC-013: the threshold is never a CLI flag', async () => {
    const { repo, base } = project();
    const head = repo.commit({ 'src/login.ts': numbered(10) }, 'login');
    lcov(repo, { 'src/login.ts': hits(10, 0) });
    expect((await ci(repo, ['coverage', base, head, '--threshold', '10'])).code).toBe(2);
  });

  it('AC-013: a .gitattributes marking sources -diff cannot hide changed lines', async () => {
    const { repo, base } = project();
    const head = repo.commit(
      { 'src/login.ts': numbered(10), '.gitattributes': '*.ts -diff\n' },
      'login',
    );
    lcov(repo, { 'src/login.ts': hits(10, 5) });
    const r = await ci(repo, ['coverage', base, head]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('5 of 10 changed lines covered');
  });

  it('AC-013: only added lines count; deleted lines and unchanged ones do not', async () => {
    const { repo } = project('', {});
    repo.commit({ 'src/login.ts': numbered(20) }, 'existing');
    const base = repo.revParse('HEAD');
    // Lines 1–10 stay, 11–20 are deleted, two new lines are added at the end (11, 12).
    const head = repo.commit({ 'src/login.ts': numbered(10) + numbered(2, 'added') }, 'edit');
    lcov(repo, { 'src/login.ts': { ...hits(10, 0), 11: 1, 12: 1 } }, true);
    const r = await ci(repo, ['coverage', base, head]);
    expect(r).toMatchObject({ code: 0 });
    expect(r.output).toContain('2 of 2 changed lines covered');
  });

  it('AC-013: a coverage report committed at the head fails, even one claiming 100%', async () => {
    const { repo, base } = project();
    lcov(repo, { 'src/login.ts': hits(10, 10) });
    repo.git(['add', '-f', 'coverage/lcov.info']);
    const head = repo.commit({ 'src/login.ts': numbered(10) }, 'login with its own report');
    const r = await ci(repo, ['coverage', base, head]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('coverage/lcov.info is committed at the head');
  });

  it('AC-013: a test file under src/ fails and names the test paths; one under tests/ is never a source', async () => {
    const { repo, base } = project();
    const head = repo.commit(
      {
        'src/foo.ts': numbered(4),
        'src/foo.test.ts': numbered(3),
        'tests/foo.test.ts': numbered(3),
      },
      'c',
    );
    lcov(repo, { 'src/foo.ts': hits(4, 4) });
    const r = await ci(repo, ['coverage', base, head]);
    expect(r.code).toBe(1);
    expect(r.output).toContain(
      'src/foo.test.ts is outside the test paths (tests/**/*.test.ts), so it never runs; move it under tests/',
    );
    expect(r.output).not.toContain('tests/foo.test.ts');

    // Only the removal: `commit` would also add the untracked report, which is refused.
    repo.git(['rm', '-q', 'src/foo.test.ts']);
    repo.git(['commit', '-q', '--no-gpg-sign', '-m', 'move the test']);
    const moved = repo.revParse('HEAD');
    expect((await ci(repo, ['coverage', base, moved])).code).toBe(0);
  });

  it('AC-013: a changed source file missing from the coverage report fails, named', async () => {
    const { repo, base } = project();
    const head = repo.commit({ 'src/login.ts': numbered(4), 'src/untested.ts': numbered(3) }, 'c');
    lcov(repo, { 'src/login.ts': hits(4, 4) });
    const r = await ci(repo, ['coverage', base, head]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('src/untested.ts: not in the coverage report');
  });
});

describe('factory ci size (QG-6)', () => {
  it('counts added plus removed lines against the stricter of the release limit and main’s size_limit_lines', async () => {
    const { repo } = project('size_limit_lines: 30\n', { 'src/a.ts': numbered(20) });
    const base = repo.revParse('HEAD');
    const at = repo.commit({ 'src/a.ts': numbered(10), 'src/b.ts': numbered(20) }, 'c');
    expect(await ci(repo, ['size', base, at])).toMatchObject({ code: 0 });
    expect((await ci(repo, ['size', base, at])).output).toContain(
      'size: 30 changed lines (limit 30)',
    );
    const over = repo.commit({ 'src/c.ts': numbered(1) }, 'one more');
    expect((await ci(repo, ['size', base, over])).code).toBe(1);
  });

  it('never counts beyond the release limit, whatever main’s config says', async () => {
    const { repo, base } = project();
    const head = repo.commit({ 'src/a.ts': numbered(401) }, 'c');
    const r = await ci(repo, ['size', base, head]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('401 changed lines (limit 400)');
  });

  it('excludes specs/**, lockfiles and generated files', async () => {
    const { repo, base } = project();
    const head = repo.commit(
      {
        'specs/42-add-login/spec.md': numbered(500),
        'package-lock.json': numbered(500),
        'sub/pnpm-lock.yaml': numbered(50),
        'dist/main.js': numbered(500),
        'coverage/lcov.info': numbered(50),
        'src/a.ts': numbered(3),
      },
      'c',
    );
    const r = await ci(repo, ['size', base, head]);
    expect(r.output).toContain('size: 3 changed lines');
    for (const path of [
      'package-lock.json',
      'sub/pnpm-lock.yaml',
      'dist/main.js',
      'coverage/lcov.info',
    ])
      expect(r.output).toContain(`not counted: ${path}`);
    expect(r.output).not.toContain('specs/');
  });

  it('a 500-line dist/bundle.js passes the limit and appears in the output', async () => {
    const { repo, base } = project();
    const head = repo.commit({ 'dist/bundle.js': numbered(500) }, 'build');
    const r = await ci(repo, ['size', base, head]);
    expect(r.code).toBe(0);
    expect(r.output).toContain('not counted: dist/bundle.js');
  });

  it('lists an executable bit set with other changes, counting only the lines', async () => {
    const { repo } = project('', { 'run.sh': 'echo hi\n' });
    const base = repo.revParse('HEAD');
    writeFileSync(join(repo.path, 'run.sh'), 'echo hi\necho there\n');
    chmodSync(join(repo.path, 'run.sh'), 0o755);
    const head = repo.commit({}, 'exec');
    const r = await ci(repo, ['size', base, head]);
    expect(r.output).toContain('size: 1 changed lines');
    expect(r.output).toContain('executable bit: run.sh');
  });

  it('a move that also sets the executable bit is not a free move', async () => {
    const { repo } = project('', { 'src/a.sh': 'echo a\n' });
    const base = repo.revParse('HEAD');
    repo.git(['mv', 'src/a.sh', 'src/b.sh']);
    chmodSync(join(repo.path, 'src/b.sh'), 0o755);
    const head = repo.commit({}, 'move');
    const r = await ci(repo, ['size', base, head]);
    expect(r.output).toContain('size: 2 changed lines');
    expect(r.output).toContain('executable bit: src/b.sh');
    expect(r.output).not.toContain('moved:');
  });

  it('a binary file, symlink, gitlink or executable-bit flip counts 1 each and is listed', async () => {
    const { repo } = project('', { 'run.sh': 'echo hi\n' });
    const base = repo.revParse('HEAD');
    writeFileSync(join(repo.path, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    symlinkSync('run.sh', join(repo.path, 'link'));
    chmodSync(join(repo.path, 'run.sh'), 0o755);
    repo.git(['add', '-A']);
    repo.git(['update-index', '--add', '--cacheinfo', `160000,${base},vendor/lib`]);
    repo.git(['commit', '-q', '--no-gpg-sign', '-m', 'types']);

    const r = await ci(repo, ['size', base, repo.revParse('HEAD')]);

    expect(r.output).toContain('size: 4 changed lines');
    for (const line of [
      'binary: logo.png',
      'symlink: link',
      'gitlink: vendor/lib',
      'executable bit: run.sh',
    ])
      expect(r.output).toContain(line);
  });

  it('a byte-identical move counts 0 and is listed; an edit made while moving counts in full', async () => {
    const { repo } = project('', { 'src/a.ts': numbered(50), 'src/b.ts': numbered(40, 'b') });
    const base = repo.revParse('HEAD');
    repo.git(['mv', 'src/a.ts', 'src/moved.ts']);
    repo.git(['rm', '-q', 'src/b.ts']);
    const head = repo.commit({ 'src/b2.ts': numbered(40, 'b') + 'export const x = 1;\n' }, 'moves');

    const r = await ci(repo, ['size', base, head]);

    expect(r.output).toContain('size: 81 changed lines');
    expect(r.output).toContain('moved: src/a.ts → src/moved.ts');
  });

  it('pairs moves one to one: a second identical copy counts in full', async () => {
    const { repo } = project('', { 'src/a.ts': numbered(10) });
    const base = repo.revParse('HEAD');
    const head = repo.commit(
      { 'src/a.ts': null, 'src/one.ts': numbered(10), 'src/two.ts': numbered(10) },
      'c',
    );
    const r = await ci(repo, ['size', base, head]);
    expect(r.output).toContain('size: 10 changed lines');
    expect(r.output).toContain('moved: src/a.ts → src/one.ts');
  });

  it('a .gitattributes marking sources -diff or binary cannot hide lines', async () => {
    const { repo, base } = project();
    const head = repo.commit({ '.gitattributes': '*.ts binary\n', 'src/a.ts': numbered(10) }, 'c');
    expect((await ci(repo, ['size', base, head])).output).toContain('size: 11 changed lines');
  });
});

const SPEC = (ids: string[]) =>
  `# Feature: login\n\n### Acceptance Scenarios\n\n${ids
    .map(
      (id, i) =>
        `${String(i + 1)}. **${id}** — **Given** a user, **When** they log in, **Then** it works.`,
    )
    .join('\n')}\n`;
const FEATURE = {
  '.specify/feature.json': JSON.stringify({ feature_directory: 'specs/42-add-login' }),
};

/** Vitest JSON results with one test per [title, status]. */
function results(repo: TestRepo, tests: [string, 'passed' | 'failed' | 'skipped'][]) {
  mkdirSync(join(repo.path, 'coverage'), { recursive: true });
  const assertionResults = tests.map(([title, status]) => ({
    ancestorTitles: ['login'],
    title,
    fullName: `login ${title}`,
    status,
  }));
  writeFileSync(
    join(repo.path, 'coverage', 'vitest-results.json'),
    JSON.stringify({ testResults: [{ name: 'tests/login.test.ts', assertionResults }] }),
  );
}

describe('factory ci ac-map (QG-2, AC-097)', () => {
  it('FR-038 (QG-2): passes when every checked criterion has a passing test naming it', async () => {
    const { repo, base } = project();
    const head = repo.commit(
      { ...FEATURE, 'specs/42-add-login/spec.md': SPEC(['AC-001', 'AC-002']) },
      's',
    );
    results(repo, [
      ['AC-001: logs in', 'passed'],
      ['AC-002: locks out', 'passed'],
    ]);
    expect(await ci(repo, ['ac-map', base, head, '--branch', BRANCH, '--tier', '2'])).toMatchObject(
      { code: 0 },
    );
  });

  it('FR-038 (QG-2): a criterion whose only test fails, or a longer ID, does not count', async () => {
    const { repo, base } = project();
    const head = repo.commit(
      { ...FEATURE, 'specs/42-add-login/spec.md': SPEC(['AC-001', 'AC-01']) },
      's',
    );
    results(repo, [
      ['AC-001: logs in', 'failed'],
      ['AC-010: something else', 'passed'],
    ]);
    const r = await ci(repo, ['ac-map', base, head, '--branch', BRANCH, '--tier', '2']);
    expect(r.code).toBe(1);
    expect(r.output).toContain('AC-001: no passing test names it');
    expect(r.output).toContain('AC-01: no passing test names it');
  });

  it('FR-038 (QG-2): tier 1, or no --tier: deleting a criterion from spec.md on the branch does not remove it', async () => {
    const { repo, base } = project();
    repo.commit({ ...FEATURE, 'specs/42-add-login/spec.md': SPEC(['AC-001', 'AC-002']) }, 's1');
    const head = repo.commit({ 'specs/42-add-login/spec.md': SPEC(['AC-001']) }, 's2');
    results(repo, [['AC-001: logs in', 'passed']]);
    for (const tier of [['--tier', '1'], []]) {
      const r = await ci(repo, ['ac-map', base, head, '--branch', BRANCH, ...tier]);
      expect(r.code).toBe(1);
      expect(r.output).toContain('AC-002: no passing test names it');
    }
  });

  it('FR-038 (QG-2): tier 2–3 check the IDs in spec.md at the head, so a dropped criterion is not required', async () => {
    const { repo, base } = project();
    repo.commit({ ...FEATURE, 'specs/42-add-login/spec.md': SPEC(['AC-001', 'AC-002']) }, 's1');
    const head = repo.commit({ 'specs/42-add-login/spec.md': SPEC(['AC-001']) }, 's2');
    results(repo, [['AC-001: logs in', 'passed']]);
    expect(await ci(repo, ['ac-map', base, head, '--branch', BRANCH, '--tier', '3'])).toMatchObject(
      { code: 0 },
    );
  });

  it('AC-097: an empty checked set fails, at every tier', async () => {
    const { repo, base } = project();
    const head = repo.commit(
      { ...FEATURE, 'specs/42-add-login/spec.md': '# Feature: login\n' },
      's',
    );
    results(repo, []);
    for (const tier of ['1', '2']) {
      const r = await ci(repo, ['ac-map', base, head, '--branch', BRANCH, '--tier', tier]);
      expect(r.code).toBe(1);
      expect(r.output).toContain('no acceptance criteria to check');
    }
  });

  it('AC-097: a criterion line without an ID fails', async () => {
    const { repo, base } = project();
    const spec = `${SPEC(['AC-001'])}2. **Given** a user, **When** they log out, **Then** it works.\n`;
    const head = repo.commit({ ...FEATURE, 'specs/42-add-login/spec.md': spec }, 's');
    results(repo, [['AC-001: logs in', 'passed']]);
    const r = await ci(repo, ['ac-map', base, head, '--branch', BRANCH, '--tier', '2']);
    expect(r.code).toBe(1);
    expect(r.output).toContain('spec.md:6: criterion line without a leading **AC-###** ID');
  });

  it('FR-038 (QG-2): a test report committed at the head fails', async () => {
    const { repo, base } = project();
    results(repo, [['AC-001: logs in', 'passed']]);
    repo.git(['add', '-f', 'coverage/vitest-results.json']);
    const head = repo.commit({ ...FEATURE, 'specs/42-add-login/spec.md': SPEC(['AC-001']) }, 's');
    const r = await ci(repo, ['ac-map', base, head, '--branch', BRANCH, '--tier', '2']);
    expect(r.code).toBe(1);
    expect(r.output).toContain('coverage/vitest-results.json is committed at the head');
  });

  it('FR-038 (QG-2): a feature.json pointing at another feature fails; no --branch is a usage error', async () => {
    const { repo, base } = project();
    repo.commit({ 'specs/7-other/spec.md': SPEC(['AC-001']) }, 'other');
    const head = repo.commit(
      { '.specify/feature.json': JSON.stringify({ feature_directory: 'specs/7-other' }) },
      'repoint',
    );
    results(repo, [['AC-001: logs in', 'passed']]);
    const r = await ci(repo, ['ac-map', base, head, '--branch', BRANCH, '--tier', '2']);
    expect(r.code).toBe(1);
    expect(r.output).toContain(
      `.specify/feature.json names specs/7-other, but the branch ${BRANCH} is the feature specs/42-add-login`,
    );
    expect((await ci(repo, ['ac-map', base, head, '--tier', '2'])).code).toBe(2);
  });

  it('refuses a --tier other than 1, 2 or 3', async () => {
    const { repo, base } = project();
    const head = repo.commit({ ...FEATURE, 'specs/42-add-login/spec.md': SPEC(['AC-001']) }, 's');
    expect((await ci(repo, ['ac-map', base, head, '--branch', BRANCH, '--tier', '4'])).code).toBe(
      2,
    );
  });
});
