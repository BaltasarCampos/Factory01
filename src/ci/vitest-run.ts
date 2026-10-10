// Running a pull request's tests the factory's way (T140, Owner decisions 2026-10-09): each tree
// is written from raw git blobs (`ls-tree -r -z` and `cat-file --batch` through `safeGit`), never
// by checkout or `git archive`, which apply `export-ignore` and `export-subst`; the project's
// install is linked in as `node_modules`; and the tests run under the Vitest the factory CLI was
// built with, with a config written here from the release's test paths. No tool config or ignore
// file of the project's is written into a tree (Owner decision 2026-10-10), and `import … from
// 'vitest'` resolves to the runner's own copy. The tests themselves are the pull request's code:
// outside GitHub Actions they and their install run only in the sandbox (T164).
import type { SpawnSyncReturns } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative } from 'node:path';
import { RefusedError } from '../cli/env.js';
import { safeGit } from '../git/diff.js';
import type { TestConfig } from '../stations/edges.js';
import { SOURCE_GLOBS } from './coverage.js';
import { npmCli, sandboxed, unsandboxed, type Runner } from './sandbox.js';

/**
 * Configs and ignore files Vitest, Vite, tsc, ESLint, Semgrep or gitleaks would read: a path with
 * any part named so is never written into a tree. The release passes its own configs.
 */
const TOOL_CONFIG =
  /^(?:(?:vitest|vite)\.config\.[cm]?[jt]s|vitest\.(?:workspace|projects)\.(?:[cm]?[jt]s|json)|tsconfig.*\.json|eslint\.config\..*|\.eslintrc.*|\.eslintignore|\.semgrep.*|\.gitleaks\.toml|\.gitleaksignore)$/;
const toolConfig = (path: string) => path.split('/').some((part) => TOOL_CONFIG.test(part));

/** A path git would never check out: absolute, or with an empty, `.`, `..` or `.git` part. */
export function unsafePath(path: string): boolean {
  return (
    path.startsWith('/') ||
    path
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git')
  );
}

interface Entry {
  mode: string;
  oid: string;
  path: string;
}

/** Writes the files of `commit` for which `keep` holds into `dir`. Gitlinks are left out. */
export function writeTree(
  repo: string,
  commit: string,
  dir: string,
  keep: (path: string) => boolean,
  env: NodeJS.ProcessEnv,
): string[] {
  const listing = safeGit(repo, ['ls-tree', '-r', '-z', '--full-tree', commit], env);
  if (listing.status !== 0) throw new RefusedError(`cannot list ${commit}: ${listing.stderr}`);
  const entries: Entry[] = listing.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const [meta = '', path = ''] = row.split('\t');
      const [mode = '', , oid = ''] = meta.split(' ');
      return { mode, oid, path };
    });
  // Every entry is checked, kept or not, before anything is written.
  const unsafe = entries.find((e) => unsafePath(e.path));
  if (unsafe !== undefined)
    throw new RefusedError(`${commit} holds an unsafe path: ${JSON.stringify(unsafe.path)}`);
  const written = entries.filter(
    (e) =>
      e.mode !== '160000' &&
      keep(e.path) &&
      !toolConfig(e.path) &&
      e.path.split('/')[0] !== 'node_modules',
  );
  if (written.length === 0) return [];
  const batch = safeGit(
    repo,
    ['cat-file', '--batch'],
    env,
    written.map((e) => e.oid).join('\n') + '\n',
  );
  if (batch.status !== 0) throw new RefusedError(`cannot read the blobs of ${commit}`);
  let at = 0;
  for (const entry of written) {
    const header = batch.stdout.indexOf(0x0a, at);
    const size = Number(batch.stdout.subarray(at, header).toString('utf8').split(' ')[2]);
    const bytes = batch.stdout.subarray(header + 1, header + 1 + size);
    at = header + 1 + size + 1;
    const full = join(dir, ...entry.path.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    if (entry.mode === '120000') symlinkSync(bytes.toString('utf8'), full);
    else {
      writeFileSync(full, bytes);
      if (entry.mode === '100755') chmodSync(full, 0o755);
    }
  }
  return written.map((e) => e.path);
}

/** Links the project's install into a tree, so its code resolves the head's dependencies. */
export function linkInstall(dir: string, install: string | undefined): void {
  if (install !== undefined && existsSync(install))
    symlinkSync(install, join(dir, 'node_modules'), 'dir');
}

const INSTALL_FILES = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc'];

/**
 * The head's dependencies, installed by `npm ci --ignore-scripts` from its own package.json and
 * lockfile in `work`, with the network on for this step only. Without a package.json there is
 * nothing to install.
 */
export function installHead(
  repo: string,
  head: string,
  work: string,
  run: Runner,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const dir = join(work, 'install');
  const files = writeTree(repo, head, dir, (p) => INSTALL_FILES.includes(p), env);
  if (!files.includes('package.json')) return undefined;
  const npm = run([process.execPath, npmCli(), 'ci', '--ignore-scripts'], dir, true);
  if (npm.status !== 0)
    throw new RefusedError(`npm ci failed: ${(npm.stderr || npm.stdout).trim().slice(-2000)}`);
  return join(dir, 'node_modules');
}

/**
 * Where pull request code runs: in GitHub Actions on the job's own install; anywhere else in the
 * sandbox, which installs the head's dependencies itself.
 */
export type Isolation = { sandbox: true } | { sandbox: false; install: string };

export interface Workspace {
  /** Writes `commit`'s files for which `keep` holds into the named tree; returns their paths. */
  write(name: string, commit: string, keep?: (path: string) => boolean): string[];
  /** The named tree's folder, inside the named run's folder. */
  tree(name: string): string;
  /** Runs `argv` in the named tree, with the install linked in. */
  run(name: string, argv: readonly string[]): SpawnSyncReturns<string>;
  /** Runs the named tree's tests; with `coverage`, lcov.info lands in the run's `coverage/`. */
  test(name: string, coverage?: boolean): TestRun;
}

/** Runs `fn` in a fresh temp folder, removed afterwards, with the head's install ready. */
export function inWorkspace<T>(
  repo: string,
  head: string,
  options: { isolation: Isolation; config: TestConfig; env: NodeJS.ProcessEnv },
  fn: (ws: Workspace) => T,
): T {
  const { env, isolation } = options;
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'factory-tests-')));
  try {
    const run = isolation.sandbox ? sandboxed(work, env) : unsandboxed(env);
    const install = isolation.sandbox ? installHead(repo, head, work, run, env) : isolation.install;
    const tree = (name: string) => join(work, name, 'tree');
    const linked = new Set<string>();
    const ready = (name: string) => {
      mkdirSync(tree(name), { recursive: true });
      if (!linked.has(name)) linkInstall(tree(name), install);
      linked.add(name);
      return tree(name);
    };
    return fn({
      write: (name, commit, keep = () => true) => writeTree(repo, commit, tree(name), keep, env),
      tree,
      run: (name, argv) => run(argv, ready(name)),
      test: (name, coverage = false) =>
        runTests(ready(name), join(work, name), options.config, run, coverage),
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The Vitest this CLI was built with: its entry (for the alias), command and coverage provider. */
function factoryVitest() {
  const require = createRequire(import.meta.url);
  // The package's CommonJS entry names its folder; the ES entry and the command sit beside it.
  const root = dirname(require.resolve('vitest'));
  return {
    entry: join(root, 'dist', 'index.js'),
    bin: join(root, 'vitest.mjs'),
    // Aliased like Vitest: by name, Vitest and its workers would load the provider from the
    // tree, where the project's install could hold its own.
    coverage: require.resolve('@vitest/coverage-v8'),
  };
}

export interface TestOutcome {
  /** Relative to the tree. */
  file: string;
  /** Describe titles and the test title, space-separated, as Vitest's `fullName`. */
  name: string;
  status: string;
  /** Run in `fails` mode, where a failing body is reported as passed. */
  fails: boolean;
  /** Retries before the last result: a test's own `{ retry: n }` overrides `retry: 0`. */
  retries: number;
}

/** Passed on its first try, not in `fails` mode. */
export const cleanPass = (t: TestOutcome) => t.status === 'passed' && !t.fails && t.retries === 0;

/**
 * The factory's reporter: Vitest's JSON report, whose `fullName` and `status` it reproduces, plus
 * each test's `fails` mode and retry count, which that report leaves out.
 */
const REPORTER = (out: string) => `import { writeFileSync } from 'node:fs';
const STATUS = { fail: 'failed', only: 'pending', pass: 'passed', run: 'pending', skip: 'skipped', todo: 'todo', queued: 'pending' };
const tests = (task) => (task.type === 'test' ? [task] : (task.tasks ?? []).flatMap(tests));
const titles = (t) => { const a = []; for (let s = t.suite; s; s = s.suite) a.unshift(s.name); return a; };
export default class {
  onFinished(files = []) {
    const testResults = files.map((f) => ({
      name: f.filepath,
      status: f.result?.state === 'fail' ? 'failed' : 'passed',
      assertionResults: tests(f).map((t) => ({
        fullName: t.name ? [...titles(t), t.name].join(' ') : titles(t).join(' '),
        status: STATUS[t.result?.state || t.mode] || 'skipped',
        fails: t.fails === true,
        retries: t.result?.retryCount ?? 0,
      })),
    }));
    writeFileSync(${JSON.stringify(out)}, JSON.stringify({ testResults }));
  }
}
`;

export interface TestRun {
  tests: TestOutcome[];
  /** Test files that failed to load: every test in them counts as failing. */
  loadFailed: Set<string>;
}

/**
 * Runs the tree's tests under the factory's Vitest and the release's test paths. With `coverage`,
 * `work/coverage/lcov.info` lists every source file, loaded by a test or not.
 */
export function runTests(
  dir: string,
  work: string,
  config: TestConfig,
  run: Runner,
  coverage = false,
): TestRun {
  const vitest = factoryVitest();
  const configDir = join(work, 'config');
  const out = join(work, 'results.json');
  mkdirSync(configDir, { recursive: true });
  const options = {
    root: dir,
    cacheDir: join(work, 'cache'),
    resolve: {
      alias: [
        { find: '^vitest$', replacement: vitest.entry },
        { find: '^@vitest/coverage-v8$', replacement: vitest.coverage },
      ],
    },
    test: {
      include: config.include,
      exclude: ['**/node_modules/**', ...config.exclude],
      setupFiles: config.setupFiles,
      globalSetup: config.globalSetup,
      reporters: [join(configDir, 'reporter.mjs')],
      retry: 0,
      passWithNoTests: true,
      watch: false,
      coverage: {
        enabled: coverage,
        provider: 'v8',
        include: SOURCE_GLOBS,
        reporter: ['lcov'],
        reportOnFailure: true,
        reportsDirectory: join(work, 'coverage'),
      },
    },
  };
  // The alias patterns go in as text and become RegExps in the config module.
  const text = `const o = ${JSON.stringify(options)};\nfor (const a of o.resolve.alias) a.find = new RegExp(a.find);\nexport default o;\n`;
  writeFileSync(join(configDir, 'vitest.config.mjs'), text);
  writeFileSync(join(configDir, 'reporter.mjs'), REPORTER(out));
  const result = run(
    [process.execPath, vitest.bin, 'run', '--config', join(configDir, 'vitest.config.mjs')],
    dir,
  );
  if (!existsSync(out))
    throw new RefusedError(
      `vitest wrote no results: ${(result.stderr || result.stdout).trim().slice(-2000)}`,
    );
  return parseResults(readFileSync(out, 'utf8'), dir);
}

type FileResult = { name?: unknown; status?: unknown; assertionResults?: unknown };
type AssertionResult = {
  fullName?: unknown;
  title?: unknown;
  ancestorTitles?: unknown;
  status?: unknown;
  fails?: unknown;
  retries?: unknown;
};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

export function parseResults(json: string, dir: string): TestRun {
  const report = JSON.parse(json) as { testResults?: unknown };
  const run: TestRun = { tests: [], loadFailed: new Set() };
  const root = realpathSync(dir);
  for (const entry of list(report.testResults)) {
    const f = entry as FileResult;
    const name = typeof f.name === 'string' ? f.name : '';
    const file = posix.normalize(
      relative(name.startsWith(root) ? root : dir, name).replaceAll('\\', '/'),
    );
    const assertions = list(f.assertionResults);
    if (f.status === 'failed' && assertions.length === 0) run.loadFailed.add(file);
    for (const a of assertions as AssertionResult[]) {
      const full =
        typeof a.fullName === 'string'
          ? a.fullName
          : [...list(a.ancestorTitles), a.title].map(String).join(' ');
      run.tests.push({
        file,
        name: full,
        status: typeof a.status === 'string' ? a.status : '',
        fails: a.fails === true,
        retries: typeof a.retries === 'number' ? a.retries : 0,
      });
    }
  }
  return run;
}
