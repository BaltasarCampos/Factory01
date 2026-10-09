// Running a pull request's tests the factory's way (T140, Owner decisions 2026-10-09): each tree
// is written from raw git blobs (`ls-tree -r -z` and `cat-file --batch` through `safeGit`), never
// by checkout or `git archive`, which apply `export-ignore` and `export-subst`; the project's
// install is linked in as `node_modules`; and the tests run under the Vitest the factory CLI was
// built with, with a config written here from the release's test paths. Nothing from the
// project's Vitest or Vite config loads, and `import … from 'vitest'` resolves to the runner's own
// copy. The tests themselves are the pull request's code and run as such.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { RefusedError } from '../cli/env.js';
import { safeGit } from '../git/diff.js';
import type { TestConfig } from '../stations/edges.js';

/** Project config files Vitest or Vite would read at the root; never written into a tree. */
const PROJECT_CONFIG =
  /^(?:vitest|vite)\.config\.[cm]?[jt]s$|^vitest\.(?:workspace|projects)\.(?:[cm]?[jt]s|json)$/;

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
      !PROJECT_CONFIG.test(e.path) &&
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
export function linkInstall(dir: string, install: string): void {
  if (existsSync(install)) symlinkSync(install, join(dir, 'node_modules'), 'dir');
}

/** The Vitest this CLI was built with: its entry (for the alias) and its command. */
function factoryVitest() {
  // The package's CommonJS entry names its folder; the ES entry and the command sit beside it.
  const root = dirname(createRequire(import.meta.url).resolve('vitest'));
  return { entry: join(root, 'dist', 'index.js'), bin: join(root, 'vitest.mjs') };
}

export interface TestOutcome {
  /** Relative to the tree. */
  file: string;
  /** Describe titles and the test title, space-separated, as Vitest's `fullName`. */
  name: string;
  status: string;
}

export interface TestRun {
  tests: TestOutcome[];
  /** Test files that failed to load: every test in them counts as failing. */
  loadFailed: Set<string>;
}

/** Runs the tree's tests under the factory's Vitest and the release's test paths. */
export function runTests(
  dir: string,
  work: string,
  config: TestConfig,
  env: NodeJS.ProcessEnv,
): TestRun {
  const vitest = factoryVitest();
  const configDir = join(work, 'config');
  const out = join(work, 'results.json');
  mkdirSync(configDir, { recursive: true });
  const options = {
    root: dir,
    cacheDir: join(work, 'cache'),
    resolve: { alias: [{ find: '^vitest$', replacement: vitest.entry }] },
    test: {
      include: config.include,
      exclude: ['**/node_modules/**', ...config.exclude],
      setupFiles: config.setupFiles,
      globalSetup: config.globalSetup,
      reporters: ['json'],
      outputFile: { json: out },
      retry: 0,
      passWithNoTests: true,
      watch: false,
    },
  };
  // The alias pattern goes in as text and becomes a RegExp in the config module.
  const text = `const o = ${JSON.stringify(options)};\no.resolve.alias[0].find = new RegExp(o.resolve.alias[0].find);\nexport default o;\n`;
  writeFileSync(join(configDir, 'vitest.config.mjs'), text);
  const clean = Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith('VITEST') && name !== 'NODE_OPTIONS'),
  );
  const run = spawnSync(
    process.execPath,
    [vitest.bin, 'run', '--config', join(configDir, 'vitest.config.mjs')],
    {
      cwd: dir,
      env: clean,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    },
  );
  if (!existsSync(out))
    throw new RefusedError(
      `vitest wrote no results: ${(run.stderr || run.stdout).trim().slice(-2000)}`,
    );
  return parseResults(readFileSync(out, 'utf8'), dir);
}

type FileResult = { name?: unknown; status?: unknown; assertionResults?: unknown };
type AssertionResult = {
  fullName?: unknown;
  title?: unknown;
  ancestorTitles?: unknown;
  status?: unknown;
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
      run.tests.push({ file, name: full, status: typeof a.status === 'string' ? a.status : '' });
    }
  }
  return run;
}
