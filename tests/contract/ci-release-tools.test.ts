// Contract tests for the CI checks' independence from the pull request (T136, T141, FR-048,
// FR-049): `factory ci test` (type check and Vitest) and `factory ci lint` run the factory's own
// tsc, Vitest and ESLint with the release's configs on a tree written from raw blobs that leaves
// out every tool config and ignore file the project could supply. Inline suppression is off.
// Off GitHub Actions they run in the laptop sandbox, which installs the head's dependencies.
import {
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoRelative } from '../../src/ci/test.js';
import { writeTree } from '../../src/ci/vitest-run.js';
import { runCli } from '../../src/cli/commands.js';
import { gitEnv, makeRepo, type Files, type TestRepo } from '../helpers/git-repo.js';
import { tempDir } from '../helpers/keys.js';

const laptop: NodeJS.ProcessEnv = { ...gitEnv, GITHUB_ACTIONS: undefined };
const actions: NodeJS.ProcessEnv = { ...gitEnv, GITHUB_ACTIONS: 'true' };
const RUN = 180_000;

const CONFIG = `factory_release: v1.0.0@${'a'.repeat(40)}\nrepo: owner/project\ninbox_issue: 1\n`;
const PACKAGE = { name: 'app', version: '1.0.0', type: 'module', scripts: { test: 'vitest run' } };
const LOCK = { name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true };

const CALC = 'export const add = (a: number, b: number): number => a + b;\n';
const TESTS = [
  "import { expect, it } from 'vitest';",
  "import { add } from '../src/calc.js';",
  "it('adds', () => { expect(add(1, 2)).toBe(3); });",
  '',
].join('\n');

/** main: a small TypeScript project that passes; the item branch checked out. */
function project(files: Files = {}) {
  const repo = makeRepo({
    files: {
      '.factory/config': CONFIG,
      '.gitignore': 'node_modules/\ncoverage/\n',
      'package.json': JSON.stringify(PACKAGE),
      'package-lock.json': JSON.stringify({ ...LOCK, packages: { '': { name: 'app' } } }),
      'src/calc.ts': CALC,
      'tests/calc.test.ts': TESTS,
      ...files,
    },
  });
  const base = repo.revParse('HEAD');
  repo.checkout('claude/42-calc', { create: true });
  return { repo, base };
}

async function ci(repo: TestRepo, args: string[], env = laptop) {
  const out: string[] = [];
  const code = await runCli(['ci', ...args], {
    stdout: { write: (s: string) => void out.push(s) },
    stderr: { write: (s: string) => void out.push(s) },
    env,
    stdinIsTTY: false,
    cwd: repo.path,
    unreadAlerts: () => Promise.reject(new Error('ci must not read the inbox')),
  });
  // The checks block the worker while their tools run; Vitest's own messages need a turn.
  await new Promise((resolve) => setImmediate(resolve));
  return { code, output: out.join('') };
}

/** The PR's attempts to lower the bar: each config the release's tools would otherwise read. */
const LOWERED: Files = {
  'package.json': JSON.stringify({ ...PACKAGE, scripts: { test: 'exit 0', lint: 'exit 0' } }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: false, noImplicitAny: false } }),
  'tests/tsconfig.json': JSON.stringify({ compilerOptions: { strict: false } }),
  'vitest.config.ts':
    'export default { test: { include: ["nothing/**"], coverage: { include: ["nothing/**"], thresholds: { lines: 0 } } } };\n',
  'eslint.config.js':
    'export default [{ ignores: ["**"] }, { rules: { "@typescript-eslint/no-explicit-any": "off" } }];\n',
  '.eslintrc.json': JSON.stringify({ root: true, ignorePatterns: ['**'] }),
  '.eslintignore': '**\n',
};

describe('factory ci test (T141, QG-1)', () => {
  it(
    'a passing head passes; its reports land in coverage/ with repository-relative paths, listing a source no test loads; coverage then passes on the same checkout',
    async () => {
      const { repo, base } = project({ 'src/lonely.ts': 'export const lonely = 1;\n' });
      const head = repo.commit(
        {
          'src/calc.ts': `${CALC}export const twice = (a: number): number => add(a, a);\n`,
          'tests/calc.test.ts': `${TESTS}it('twice', async () => { const { twice } = await import('../src/calc.js'); expect(twice(2)).toBe(4); });\n`,
        },
        'twice',
      );

      const r = await ci(repo, ['test', head]);

      expect(r).toMatchObject({ code: 0 });
      expect(r.output).toContain('test: 2 of 2 tests passed, 0 type errors');
      const lcov = readFileSync(join(repo.path, 'coverage', 'lcov.info'), 'utf8');
      expect(lcov.match(/^SF:.*$/gm)).toEqual(['SF:src/calc.ts', 'SF:src/lonely.ts']);
      const results = readFileSync(join(repo.path, 'coverage', 'vitest-results.json'), 'utf8');
      expect(results).toContain('"fullName":"twice"');

      expect(await ci(repo, ['coverage', base, head])).toMatchObject({ code: 0 });
    },
    RUN,
  );

  it(
    'a failing test, a test file that cannot load and a type error each fail by name, whatever the PR’s package.json, tsconfig and Vitest config say; coverage still measures every source',
    async () => {
      const { repo, base } = project();
      const head = repo.commit(
        {
          ...LOWERED,
          // Only strict mode catches the implicit any; the PR's tsconfig turns it off.
          'src/calc.ts': `${CALC}export const loose = (a) => a;\nexport function unused(): number {\n  return 2;\n}\n`,
          'tests/calc.test.ts': `${TESTS}it('breaks', () => { expect(add(2, 2)).toBe(5); });\n`,
          'tests/broken.test.ts': "import { gone } from '../src/gone.js';\ngone();\n",
          // Type-checked wherever it sits, not only under src/ and tests/.
          'lib/util.ts': "export const n: number = 'x';\n",
        },
        'lower the bar',
      );

      const r = await ci(repo, ['test', head]);

      expect(r.code).toBe(1);
      expect(r.output).toContain('test:tests/calc.test.ts#breaks: failed');
      expect(r.output).toContain('test:tests/broken.test.ts: failed to load');
      expect(r.output).toMatch(
        /src\/calc\.ts:2: TS7006 Parameter 'a' implicitly has an 'any' type/,
      );
      expect(r.output).toMatch(/lib\/util\.ts:1: TS2322 /);
      expect(r.output).toContain('1 of 2 tests passed');
      expect(r.output).not.toContain('test:tests/calc.test.ts#adds');

      const coverage = await ci(repo, ['coverage', base, head]);
      expect(coverage.code).toBe(1);
      expect(coverage.output).toMatch(/2 of 4 changed lines covered \(threshold 90%\)/);
    },
    RUN,
  );
});

const ANY = 'export const loose: any = 1;\n';

describe('factory ci lint (T141, QG-4)', () => {
  it(
    'a clean head passes; a lint error fails by file, line and rule, whatever ESLint config and ignore files the PR adds',
    async () => {
      const { repo } = project();
      expect(await ci(repo, ['lint', 'HEAD'])).toMatchObject({ code: 0 });
      const head = repo.commit({ ...LOWERED, 'src/calc.ts': `${CALC}${ANY}` }, 'any');

      const r = await ci(repo, ['lint', head]);

      expect(r.code).toBe(1);
      expect(r.output).toContain(
        'src/calc.ts:2: @typescript-eslint/no-explicit-any Unexpected any. Specify a different type.',
      );
    },
    RUN,
  );

  it(
    'lever: an eslint-disable comment silences nothing, and is itself reported',
    async () => {
      const { repo } = project();
      const head = repo.commit(
        {
          'src/calc.ts': `/* eslint-disable */\n${CALC}// eslint-disable-next-line @typescript-eslint/no-explicit-any\n${ANY}`,
        },
        'disable',
      );

      const r = await ci(repo, ['lint', head]);

      expect(r.code).toBe(1);
      expect(r.output).toContain('src/calc.ts:4: @typescript-eslint/no-explicit-any');
      expect(r.output).toMatch(
        /src\/calc\.ts:1: eslint .*has no effect because you have 'noInlineConfig'/,
      );
      expect(r.output).toMatch(
        /src\/calc\.ts:3: eslint .*has no effect because you have 'noInlineConfig'/,
      );
    },
    RUN,
  );

  it(
    'lever: a type error fails the type check; hidden under @ts-ignore, @ts-nocheck or @ts-expect-error, lint fails on the comment',
    async () => {
      const { repo } = project();
      const typeError = repo.commit(
        { 'src/calc.ts': `${CALC}export const n: number = 'x';\n` },
        'type error',
      );
      const before = await ci(repo, ['test', typeError]);
      expect(before.code).toBe(1);
      expect(before.output).toMatch(/src\/calc\.ts:2: TS2322 /);

      const head = repo.commit(
        {
          'src/calc.ts': `${CALC}// @ts-ignore\nexport const n: number = 'x';\n`,
          'src/other.ts': "// @ts-nocheck\nexport const m: number = 'x';\n",
          'src/third.ts':
            "// @ts-expect-error: a description long enough for the default rule\nexport const k: number = 'x';\n",
        },
        'hide it',
      );

      const r = await ci(repo, ['lint', head]);

      expect(r.code).toBe(1);
      expect(r.output).toContain('src/calc.ts:2: @typescript-eslint/ban-ts-comment');
      expect(r.output).toContain('src/other.ts:1: @typescript-eslint/ban-ts-comment');
      expect(r.output).toContain('src/third.ts:1: @typescript-eslint/ban-ts-comment');
    },
    RUN,
  );
});

describe('factory ci lint covers the whole tree (T141)', () => {
  it(
    'every TypeScript file is linted wherever it sits; a JavaScript or .tsx file is a finding, even beside a .d.ts',
    async () => {
      const { repo } = project();
      const head = repo.commit(
        {
          'lib/helper.ts': ANY,
          'src/helper.js': 'export const loose = 1;\n',
          'src/helper.d.ts': 'export declare const loose: number;\n',
          'src/view.tsx': 'export const view = 1;\n',
          'scripts/build.mjs': 'export default 1;\n',
          'dist/server.js': 'export {};\n',
        },
        'outside src',
      );

      const r = await ci(repo, ['lint', head]);

      expect(r.code).toBe(1);
      expect(r.output).toContain('lib/helper.ts:1: @typescript-eslint/no-explicit-any');
      for (const path of ['src/helper.js', 'src/view.tsx', 'scripts/build.mjs'])
        expect(r.output).toContain(`${path}: the TypeScript profile takes TypeScript only`);
      expect(r.output).not.toMatch(/dist\/server\.js|src\/helper\.d\.ts/);
    },
    RUN,
  );
});

describe('factory ci test and lint in GitHub Actions, on the job’s install (T141)', () => {
  it(
    'the PR’s configs are still ignored, and a coverage provider planted in the install is never loaded',
    async () => {
      const { repo } = project();
      const head = repo.commit(
        {
          ...LOWERED,
          'src/calc.ts': `${CALC}export const lax = (a) => a;\n${ANY}`,
          'tests/calc.test.ts': `${TESTS}it('breaks', () => { expect(add(2, 2)).toBe(5); });\n`,
        },
        'lower the bar',
      );
      // The job's install, as `npm ci` would have made it from the head's lockfile.
      const install = join(tempDir(), 'node_modules');
      const marker = join(tempDir(), 'planted-provider-loaded');
      const planted = join(install, '@vitest', 'coverage-v8');
      mkdirSync(planted, { recursive: true });
      writeFileSync(
        join(planted, 'package.json'),
        JSON.stringify({
          name: '@vitest/coverage-v8',
          version: '3.2.7',
          type: 'module',
          main: 'index.js',
        }),
      );
      writeFileSync(
        join(planted, 'index.js'),
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\nexport default { getProvider: () => ({}) };\n`,
      );

      const test = await ci(repo, ['test', head, '--install', install], actions);

      expect(test.code).toBe(1);
      expect(test.output).toContain('test:tests/calc.test.ts#breaks: failed');
      expect(test.output).toMatch(/src\/calc\.ts:2: TS7006 /);
      expect(existsSync(marker)).toBe(false);
      const lcov = readFileSync(join(repo.path, 'coverage', 'lcov.info'), 'utf8');
      expect(lcov.match(/^SF:.*$/gm)).toEqual(['SF:src/calc.ts']);

      const lint = await ci(repo, ['lint', head, '--install', install], actions);

      expect(lint.code).toBe(1);
      expect(lint.output).toContain('src/calc.ts:3: @typescript-eslint/no-explicit-any');
    },
    RUN,
  );
});

describe('the profile skeleton (T047, T130)', () => {
  it(
    'a project made from the skeleton as shipped passes factory ci test and lint',
    async () => {
      const skeleton = fileURLToPath(
        new URL('../../factory/profiles/typescript/skeleton', import.meta.url),
      );
      const files = readdirSync(skeleton, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => relative(skeleton, join(e.parentPath, e.name)));
      const repo = makeRepo({
        files: Object.fromEntries(files.map((f) => [f, readFileSync(join(skeleton, f), 'utf8')])),
      });
      // Its dependencies (@types/node, typescript, vitest) at the factory's own versions.
      const install = fileURLToPath(new URL('../../node_modules', import.meta.url));

      for (const check of ['test', 'lint'])
        expect(await ci(repo, [check, 'HEAD', '--install', install], actions)).toMatchObject({
          code: 0,
        });
    },
    RUN,
  );
});

describe('the trees the release’s tools run on (T141)', () => {
  it('leave out every tool config and ignore file the project could supply, at any depth', () => {
    const configs = [
      'tsconfig.json',
      'tsconfig.build.json',
      'tests/tsconfig.json',
      'eslint.config.js',
      'eslint.config.mjs',
      'src/eslint.config.ts',
      '.eslintrc',
      '.eslintrc.cjs',
      'src/.eslintrc.json',
      '.eslintignore',
      '.semgrepignore',
      '.semgrep.yml',
      '.semgrep/rules.yml',
      '.gitleaks.toml',
      'src/.gitleaksignore',
      '.gitleaksignore',
      'vitest.config.ts',
      'vite.config.mjs',
      'vitest.workspace.json',
    ];
    const kept = ['src/calc.ts', 'tests/calc.test.ts', 'package.json', 'docs/tsconfig.md'];
    const repo = makeRepo({
      files: Object.fromEntries([...configs, ...kept].map((p) => [p, 'x\n'])),
    });
    const dir = realpathSync(mkdtempSync(join(tempDir(), 'tree-')));

    const written = writeTree(repo.path, 'HEAD', dir, () => true, gitEnv);

    expect(written.sort()).toEqual(kept.sort());
  });

  it('lcov paths become repository-relative: the tree stands in for the repository root', () => {
    const text = 'TN:\nSF:/w/head/tree/src/calc.ts\nDA:1,1\nend_of_record\nSF:src/b.ts\nDA:1,0\n';
    expect(repoRelative(text, '/w/head/tree')).toBe(
      'TN:\nSF:src/calc.ts\nDA:1,1\nend_of_record\nSF:src/b.ts\nDA:1,0\n',
    );
  });
});
