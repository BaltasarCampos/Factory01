// `factory ci test` (T141, contracts/ci-checks.md, QG-1): the head's type check and tests, run by
// the factory's own tsc and Vitest with the release's tsconfig and test paths on a tree written
// from raw blobs, where the red-green run would run them (Owner decisions 2026-10-09/10). The
// reports go back into the checkout's `coverage/`, where `coverage` and `ac-map` read them.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { RefusedError } from '../cli/env.js';
import { TEST_CONFIG } from '../stations/edges.js';
import { factoryRoot } from './sandbox.js';
import { inWorkspace, type Isolation, type Workspace } from './vitest-run.js';

/** The release's CI configs for the TypeScript profile, shipped with the CLI. */
export const RELEASE_CI = join(factoryRoot(), 'factory', 'profiles', 'typescript', 'ci');
const MODULES = join(factoryRoot(), 'node_modules');

/**
 * Writes the release's tsconfig.json into a tree, its only one. Node's types and Vitest's come
 * from the factory's own install, as the test run takes Vitest itself.
 */
export function writeTsconfig(tree: string): void {
  const config = JSON.parse(readFileSync(join(RELEASE_CI, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: Record<string, unknown>;
  };
  config.compilerOptions.typeRoots = [join(MODULES, '@types')];
  config.compilerOptions.paths = { vitest: [join(MODULES, 'vitest', 'dist', 'index.d.ts')] };
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, 'tsconfig.json'), JSON.stringify(config));
}

const TS_ERROR = /^(.+)\((\d+),\d+\): error (TS\d+): (.*)$/;

/** tsc's errors, one finding each: `<path>:<line>: TS<code> <message>`. */
function typeCheck(ws: Workspace): string[] {
  const tsc = ws.run('head', [
    process.execPath,
    join(MODULES, 'typescript', 'bin', 'tsc'),
    ...['-p', 'tsconfig.json', '--pretty', 'false'],
  ]);
  const errors = tsc.stdout
    .split('\n')
    .filter((row) => /error TS\d+:/.test(row))
    .map((row) => {
      const m = TS_ERROR.exec(row);
      return m === null ? row : `${m[1] ?? ''}:${m[2] ?? ''}: ${m[3] ?? ''} ${m[4] ?? ''}`;
    });
  if (tsc.status !== 0 && errors.length === 0)
    throw new RefusedError(`tsc failed: ${(tsc.stderr || tsc.stdout).trim().slice(-2000)}`);
  return errors;
}

/** lcov with each `SF:` path relative to the repository: the tree stands in for its root. */
export function repoRelative(lcov: string, tree: string): string {
  return lcov
    .split('\n')
    .map((row) => {
      const sf = row.slice(3);
      if (!row.startsWith('SF:') || !isAbsolute(sf)) return row;
      const path = relative(tree, sf);
      return path.startsWith('..') ? row : `SF:${path.split(sep).join('/')}`;
    })
    .join('\n');
}

export interface TestCheck {
  findings: string[];
  passed: number;
  total: number;
  typeErrors: number;
}

export function testHead(
  repo: string,
  head: string,
  options: { isolation: Isolation; env: NodeJS.ProcessEnv },
): TestCheck {
  return inWorkspace(repo, head, { ...options, config: TEST_CONFIG }, (ws) => {
    ws.write('head', head);
    const tree = ws.tree('head');
    writeTsconfig(tree);
    const typeErrors = typeCheck(ws);
    const run = ws.test('head', true);
    // The run's reports sit beside its tree.
    const lcov = join(dirname(tree), 'coverage', 'lcov.info');
    if (!existsSync(lcov)) throw new RefusedError('vitest wrote no coverage report');
    const reports = join(repo, 'coverage');
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(reports, 'lcov.info'), repoRelative(readFileSync(lcov, 'utf8'), tree));
    copyFileSync(join(dirname(tree), 'results.json'), join(reports, 'vitest-results.json'));
    const failed = run.tests.filter((t) => t.status === 'failed');
    return {
      findings: [
        ...typeErrors,
        ...[...run.loadFailed].map((file) => `test:${file}: failed to load`),
        ...failed.map((t) => `test:${t.file}#${t.name}: failed`),
      ],
      passed: run.tests.filter((t) => t.status === 'passed').length,
      total: run.tests.length,
      typeErrors: typeErrors.length,
    };
  });
}
