// Contract tests for `factory ci red-green` (T135, contracts/ci-checks.md, FR-042, AC-012,
// AC-089, AC-097): every checked acceptance criterion has a tagged test that fails at the merge
// base and passes at the head. Both runs use the factory's own Vitest on trees written from raw
// git blobs, the base run being the base sources with the head's test code laid over them.
// Outside GitHub Actions both runs are sandboxed (T164); in it they use the job's install.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeTree } from '../../src/ci/vitest-run.js';
import { runCli } from '../../src/cli/commands.js';
import { gitEnv, makeRepo, type Files, type TestRepo } from '../helpers/git-repo.js';
import { tempDir } from '../helpers/keys.js';

const CONFIG = `factory_release: v1.0.0@${'a'.repeat(40)}\nrepo: owner/project\ninbox_issue: 1\n`;
const FEATURE_DIR = 'specs/42-calc';
const FEATURE = { '.specify/feature.json': JSON.stringify({ feature_directory: FEATURE_DIR }) };
const SPEC = (ids: string[]) =>
  `# Feature: calc\n\n### Acceptance Scenarios\n\n${ids
    .map(
      (id, i) =>
        `${String(i + 1)}. **${id}** — **Given** numbers, **When** combined, **Then** right.`,
    )
    .join('\n')}\n`;

/** main: a calculator whose `add` has a bug, with one passing test; the item branch checked out. */
function project(files: Files = {}) {
  const repo = makeRepo({
    files: {
      '.factory/config': CONFIG,
      '.gitignore': 'node_modules/\ncoverage/\n',
      'src/calc.ts': 'export const add = (a: number, b: number) => a - b;\nexport const one = 1;\n',
      'tests/calc.test.ts':
        "import { expect, it } from 'vitest';\nimport { one } from '../src/calc.js';\nit('one is one', () => { expect(one).toBe(1); });\n",
      ...files,
    },
  });
  const base = repo.revParse('HEAD');
  repo.checkout(BRANCH, { create: true });
  return { repo, base };
}

/** A package in the project's own install, outside git, as `npm ci` would leave it. */
function installed(repo: TestRepo, name: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    const full = join(repo.path, 'node_modules', name, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
}

const BRANCH = 'claude/42-calc';

/** The laptop: the runs are sandboxed. */
const laptop: NodeJS.ProcessEnv = { ...gitEnv, GITHUB_ACTIONS: undefined };
/** GitHub's runner: the runs use the job's install, the checkout's `node_modules`. */
const actions: NodeJS.ProcessEnv = { ...gitEnv, GITHUB_ACTIONS: 'true' };

async function ci(
  repo: TestRepo,
  args: string[],
  branch: string[] = ['--branch', BRANCH],
  env = laptop,
) {
  const out: string[] = [];
  const code = await runCli(['ci', 'red-green', ...args, ...branch], {
    stdout: { write: (s: string) => void out.push(s) },
    stderr: { write: (s: string) => void out.push(s) },
    env,
    stdinIsTTY: false,
    cwd: repo.path,
    unreadAlerts: () => Promise.reject(new Error('ci must not read the inbox')),
  });
  return { code, output: out.join('') };
}

const RUN = 120_000;

describe('factory ci red-green: each checked criterion (AC-012, AC-089)', () => {
  it(
    'AC-012, AC-089: red at base and green at head passes; already green, untagged, skipped or missing does not',
    async () => {
      const { repo, base } = project();
      const head = repo.commit(
        {
          ...FEATURE,
          [`${FEATURE_DIR}/spec.md`]: SPEC([
            'AC-001',
            'AC-002',
            'AC-003',
            'AC-004',
            'AC-005',
            'AC-006',
            'AC-007',
          ]),
          // A new module: its test file cannot load at base, which is red for every test in it.
          'src/mul.ts': 'export const mul = (a: number, b: number) => a * b;\n',
          'tests/mul.test.ts': [
            "import { expect, it } from 'vitest';",
            "import { mul } from '../src/mul.js';",
            "it('AC-001: multiplies', () => { expect(mul(2, 3)).toBe(6); });",
            "it('AC-005: multiplies by zero', () => { expect(mul(2, 0)).toBe(0); });",
            '',
          ].join('\n'),
          // The bug fix: the head version of a changed test runs against the base sources.
          'src/calc.ts':
            'export const add = (a: number, b: number) => a + b;\nexport const one = 1;\n',
          'tests/calc.test.ts': [
            "import { existsSync } from 'node:fs';",
            "import { expect, it } from 'vitest';",
            "import { add, one } from '../src/calc.js';",
            "it('one is one', () => { expect(one).toBe(1); });",
            "it('AC-002: adds', () => { expect(add(2, 3)).toBe(5); });",
            "it('AC-003: one stays one', () => { expect(one).toBe(1); });",
            "it('untagged and failing at base', () => { expect(add(1, 1)).toBe(2); });",
            "it.skipIf(!existsSync('src/mul.ts'))('AC-006: skipped at base, green at head', () => { expect(one).toBe(1); });",
            "it.skip('AC-007: skipped at head', () => { expect(add(1, 1)).toBe(0); });",
            '',
          ].join('\n'),
        },
        'calc',
      );

      const r = await ci(repo, [base, head, '--tier', '2']);

      expect(r.code).toBe(1);
      expect(r.output).not.toMatch(/AC-001:|AC-002:|AC-005:/);
      expect(r.output).toContain(
        `AC-003: no tagged test fails at the merge base and passes at the head; a refactor needs a gate:red-green waiver for ${head}`,
      );
      expect(r.output).toContain('AC-004: no test names it');
      expect(r.output).toContain('AC-006: no tagged test fails at the merge base');
      expect(r.output).toContain('AC-007: no tagged test fails at the merge base');
      expect(r.output).toContain('3 of 7 checked criteria seen failing first');
    },
    RUN,
  );

  it(
    'AC-089: at tier 1 a criterion deleted from spec.md stays checked, and the finding names its waiver',
    async () => {
      const { repo, base } = project();
      repo.commit({ ...FEATURE, [`${FEATURE_DIR}/spec.md`]: SPEC(['AC-001', 'AC-002']) }, 'spec');
      const head = repo.commit(
        {
          [`${FEATURE_DIR}/spec.md`]: SPEC(['AC-001']),
          'src/mul.ts': 'export const mul = (a: number, b: number) => a * b;\n',
          'tests/mul.test.ts':
            "import { expect, it } from 'vitest';\nimport { mul } from '../src/mul.js';\nit('AC-001: multiplies', () => { expect(mul(2, 3)).toBe(6); });\n",
        },
        'drop AC-002',
      );

      const tier1 = await ci(repo, [base, head]);
      expect(tier1.code).toBe(1);
      expect(tier1.output).toContain(
        `AC-002: no test names it; dropped from spec.md, a gate:ac-002 waiver for ${head} removes it`,
      );
      expect(await ci(repo, [base, head, '--tier', '3'])).toMatchObject({ code: 0 });
    },
    RUN,
  );

  it('AC-097: an empty checked set fails, and so does a criterion line without an ID', async () => {
    const { repo, base } = project();
    const empty = repo.commit(
      { ...FEATURE, [`${FEATURE_DIR}/spec.md`]: '# Feature: calc\n' },
      'spec',
    );
    expect((await ci(repo, [base, empty, '--tier', '2'])).output).toContain(
      'no acceptance criteria to check',
    );
    const noId = repo.commit(
      {
        [`${FEATURE_DIR}/spec.md`]: `${SPEC(['AC-001'])}2. **Given** x, **When** y, **Then** z.\n`,
      },
      'spec',
    );
    const r = await ci(repo, [base, noId, '--tier', '2']);
    expect(r.code).toBe(1);
    expect(r.output).toContain('criterion line without a leading **AC-###** ID');
  });
});

describe('factory ci red-green: a pass that is not green', () => {
  it(
    'AC-012: a tagged it.fails test, or one passing only after a retry, is not seen failing first',
    async () => {
      const { repo, base } = project();
      const head = repo.commit(
        {
          ...FEATURE,
          [`${FEATURE_DIR}/spec.md`]: SPEC(['AC-001', 'AC-002', 'AC-003']),
          // A new module: the file cannot load at base, which is red for every test in it.
          'src/mul.ts': 'export const mul = (a: number, b: number) => a * b;\n',
          'tests/mul.test.ts': [
            "import { expect, it } from 'vitest';",
            "import { mul } from '../src/mul.js';",
            "it.fails('AC-001: inverted', () => { expect(mul(2, 3)).toBe(7); });",
            'let tries = 0;',
            "it('AC-002: flaky', { retry: 3 }, () => { tries += 1; expect(tries).toBe(2); });",
            "it('AC-003: multiplies', () => { expect(mul(2, 3)).toBe(6); });",
            '',
          ].join('\n'),
        },
        'mul',
      );
      const r = await ci(repo, [base, head, '--tier', '2']);
      expect(r.output).toContain('AC-001: no tagged test fails at the merge base and passes');
      expect(r.output).toContain('AC-002: no tagged test fails at the merge base and passes');
      expect(r.output).not.toContain('AC-003:');
      expect(r.output).toContain('1 of 3 checked criteria seen failing first');
    },
    RUN,
  );
});

describe('factory ci red-green: the feature folder is the branch’s', () => {
  it('AC-089: a feature.json pointing at another feature fails; no --branch is a usage error', async () => {
    const { repo, base } = project();
    repo.commit({ 'specs/7-other/spec.md': SPEC(['AC-001']) }, 'other');
    const head = repo.commit(
      {
        '.specify/feature.json': JSON.stringify({ feature_directory: 'specs/7-other' }),
        'tests/more.test.ts': "import { it } from 'vitest';\nit('AC-001: more', () => {});\n",
      },
      'repoint',
    );
    const r = await ci(repo, [base, head, '--tier', '2']);
    expect(r.code).toBe(1);
    expect(r.output).toContain(
      `.specify/feature.json names specs/7-other, but the branch ${BRANCH} is the feature specs/42-calc`,
    );
    expect((await ci(repo, [base, head, '--tier', '2'], [])).code).toBe(2);
    expect((await ci(repo, [base, head], ['--branch', 'claude/define'])).output).toContain(
      'claude/define is not a work-item branch',
    );
  });
});

describe('writeTree: paths git would never check out', () => {
  it.each(['..', '.', '.git', '.GIT', ''])(
    'refuses a tree holding a %j part, writing nothing',
    (name) => {
      const { repo } = project();
      const git = (args: string[], input: string) =>
        execFileSync('git', args, { cwd: repo.path, env: gitEnv, input, encoding: 'utf8' }).trim();
      const blob = git(['hash-object', '-w', '--stdin'], 'x\n');
      const inner = git(['mktree'], `100644 blob ${blob}\tf\n`);
      const root = git(
        ['mktree'],
        `040000 tree ${inner}\t${name}\n100644 blob ${blob}\tsafe.txt\n`,
      );
      const commit = repo.git(['commit-tree', root, '-m', 'crafted']);
      const dir = tempDir();

      // git cannot even list a tree with an empty name; the other names reach the path check.
      expect(() => writeTree(repo.path, commit, dir, () => true, gitEnv)).toThrow(
        name === '' ? /cannot list/ : /unsafe path/,
      );
      expect(readdirSync(dir)).toEqual([]);
    },
  );
});

describe('factory ci red-green: the test-only skip (FR-042)', () => {
  it('AC-089: tests plus the item’s own feature folder skip the check, listing the files', async () => {
    const { repo, base } = project();
    const head = repo.commit(
      {
        ...FEATURE,
        [`${FEATURE_DIR}/spec.md`]: SPEC(['AC-001']),
        'tests/helpers/numbers.ts': 'export const two = 2;\n',
        'tests/more.test.ts': "import { it } from 'vitest';\nit('AC-001: more', () => {});\n",
      },
      'tests only',
    );
    const r = await ci(repo, [base, head, '--tier', '2']);
    expect(r.code).toBe(0);
    expect(r.output).toContain('red-green skipped: only test code changed');
    expect(r.output).toContain('tests/helpers/numbers.ts');
    expect(r.output).toContain('tests/more.test.ts');
  });

  it(
    'AC-089: another feature’s spec.md, or a source file, stops the skip; widening the patterns in the project changes nothing',
    async () => {
      const { repo, base } = project();
      const other = repo.commit(
        {
          ...FEATURE,
          [`${FEATURE_DIR}/spec.md`]: SPEC(['AC-001']),
          'specs/7-other/spec.md': '# Other\n',
          'tests/more.test.ts': "import { it } from 'vitest';\nit('AC-001: more', () => {});\n",
          'factory/profiles/typescript/ci/test-paths.json': JSON.stringify({
            paths: ['**'],
            include: ['**/*.test.ts'],
            exclude: [],
            setupFiles: [],
            globalSetup: [],
          }),
          'test-paths.json': JSON.stringify({ paths: ['**'] }),
        },
        'other spec',
      );
      const r = await ci(repo, [base, other, '--tier', '2']);
      expect(r.output).not.toContain('skipped');
      expect(r.output).toContain('AC-001: no tagged test fails at the merge base');
    },
    RUN,
  );
});

const featureCommit = (repo: TestRepo, extra: Files = {}) =>
  repo.commit(
    {
      ...FEATURE,
      [`${FEATURE_DIR}/spec.md`]: SPEC(['AC-001', 'AC-002']),
      'src/mul.ts':
        "import { factor } from 'fake-dep';\nexport const mul = (a: number, b: number) => a * b * factor;\n",
      'tests/mul.test.ts': [
        "import { expect, it } from 'vitest';",
        "import { mul } from '../src/mul.js';",
        "it('AC-001: multiplies through a dependency', () => { expect(mul(2, 3)).toBe(6); });",
        'let tries = 0;',
        "it('AC-002: passes only on a retry', () => { tries += 1; expect(tries).toBe(2); });",
        '',
      ].join('\n'),
      ...extra,
    },
    'feature',
  );

describe('factory ci red-green: the factory’s Vitest, never the project’s', () => {
  it(
    'runs with no Vitest in the project, resolving the project’s dependencies through the linked install',
    async () => {
      const { repo, base } = project();
      installed(repo, 'fake-dep', {
        'package.json': JSON.stringify({ name: 'fake-dep', type: 'module', main: 'index.js' }),
        'index.js': 'export const factor = 1;\n',
      });
      const head = featureCommit(repo);
      const r = await ci(repo, [base, head, '--tier', '2'], undefined, actions);
      expect(r.output).not.toContain('AC-001:');
      // No retries: the project cannot make a flaky test pass.
      expect(r.output).toContain('AC-002: no tagged test fails at the merge base');
    },
    RUN,
  );

  it(
    'ignores a project Vitest of another version and a project config with retry, an empty include and passWithNoTests',
    async () => {
      const { repo, base } = project();
      installed(repo, 'fake-dep', {
        'package.json': JSON.stringify({ name: 'fake-dep', type: 'module', main: 'index.js' }),
        'index.js': 'export const factor = 1;\n',
      });
      installed(repo, 'vitest', {
        'package.json': JSON.stringify({
          name: 'vitest',
          version: '0.0.1',
          type: 'module',
          main: 'index.js',
        }),
        'index.js': "throw new Error('the project’s own vitest was loaded');\n",
      });
      const config =
        'export default { test: { retry: 5, include: ["nothing/**"], passWithNoTests: true } };\n';
      const head = featureCommit(repo, {
        'vitest.config.ts': config,
        'vite.config.ts': config,
        'vitest.workspace.ts': 'export default ["nothing"];\n',
      });
      const r = await ci(repo, [base, head, '--tier', '2'], undefined, actions);
      expect(r.output).not.toContain('AC-001:');
      expect(r.output).not.toContain('the project’s own vitest');
      expect(r.output).toContain('AC-002: no tagged test fails at the merge base');
    },
    RUN,
  );
});

describe('factory ci red-green: the install', () => {
  it(
    'on the laptop installs the head’s package.json and lockfile in the sandbox; --install is a usage error there',
    async () => {
      const { repo, base } = project();
      const head = featureCommit(repo, {
        'package.json': JSON.stringify({ name: 'calc', version: '1.0.0' }),
        'package-lock.json': JSON.stringify({
          name: 'calc',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: { '': { name: 'calc', version: '1.0.0' } },
        }),
      });
      // `fake-dep` is in the checkout's node_modules only: the sandbox never sees that install.
      installed(repo, 'fake-dep', {
        'package.json': JSON.stringify({ name: 'fake-dep', type: 'module', main: 'index.js' }),
        'index.js': 'export const factor = 1;\n',
      });
      // The test file cannot load at the head without it, so no test names AC-001.
      const r = await ci(repo, [base, head, '--tier', '2']);
      expect(r.output).toContain('AC-001: no test names it');
      // The install is the head's: without its lockfile, npm ci refuses.
      const unlocked = repo.commit({ 'package-lock.json': null }, 'no lockfile');
      const refused = await ci(repo, [base, unlocked, '--tier', '2']);
      expect(refused.code).toBe(1);
      expect(refused.output).toContain('npm ci failed');
      const usage = await ci(repo, [base, head, '--install', join(repo.path, 'node_modules')]);
      expect(usage).toMatchObject({ code: 2 });
      expect(usage.output).toContain('--install is accepted only in GitHub Actions');
    },
    RUN,
  );

  it(
    'in GitHub Actions uses the install --install names',
    async () => {
      const { repo, base } = project();
      const elsewhere = tempDir();
      mkdirSync(join(elsewhere, 'fake-dep'), { recursive: true });
      writeFileSync(
        join(elsewhere, 'fake-dep', 'package.json'),
        JSON.stringify({ name: 'fake-dep', type: 'module', main: 'index.js' }),
      );
      writeFileSync(join(elsewhere, 'fake-dep', 'index.js'), 'export const factor = 1;\n');
      const head = featureCommit(repo);
      const r = await ci(
        repo,
        [base, head, '--tier', '2', '--install', elsewhere],
        undefined,
        actions,
      );
      expect(r.output).not.toContain('AC-001:');
    },
    RUN,
  );
});
