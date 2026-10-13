// `factory ci test` (T141, contracts/ci-checks.md, QG-1): the head's type check and tests, run by
// the factory's own tsc and Vitest with the release's tsconfig and test paths on a tree written
// from raw blobs, where the red-green run would run them (Owner decisions 2026-10-09/10). The
// reports go back into the checkout's `coverage/`, where `coverage` and `ac-map` read them.
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { RefusedError } from '../cli/env.js';
import { readCapped, replaceFile } from '../fs/safe-files.js';
import { TEST_CONFIG } from '../stations/edges.js';
import { factoryRoot } from './sandbox.js';
import { inWorkspace, REPORT_CAP, type Isolation, type Workspace } from './vitest-run.js';

/** The release's CI configs for the TypeScript profile, shipped with the CLI. */
export const RELEASE_CI = join(factoryRoot(), 'factory', 'profiles', 'typescript', 'ci');
const MODULES = join(factoryRoot(), 'node_modules');

/**
 * The release's tsconfig.json, a tree's only one. Node's types and Vitest's come from the
 * factory's own install, as the test run takes Vitest itself.
 */
export function tsconfig(): string {
  const config = JSON.parse(readFileSync(join(RELEASE_CI, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: Record<string, unknown>;
  };
  config.compilerOptions.typeRoots = [join(MODULES, '@types')];
  config.compilerOptions.paths = { vitest: [join(MODULES, 'vitest', 'dist', 'index.d.ts')] };
  return JSON.stringify(config);
}

const TS_ERROR = /^(.+)\((\d+),\d+\): error (TS\d+): (.*)$/;

/** tsc's errors in the named tree, one finding each: `<path>:<line>: TS<code> <message>`. */
function typeCheck(ws: Workspace, name: string): string[] {
  const tsc = ws.run(name, [
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
    // The type check runs in a folder of its own, since the factory writes into a run's folder
    // only before the first run there.
    ws.write('types', head);
    ws.file('types', 'tsconfig.json', tsconfig());
    const typeErrors = typeCheck(ws, 'types');
    ws.write('head', head);
    ws.file('head', 'tsconfig.json', tsconfig());
    const tree = ws.tree('head');
    const run = ws.test('head', true);
    // The run's reports sit beside its tree, where the run itself could have put a link.
    const lcov = readCapped(join(dirname(tree), 'coverage', 'lcov.info'), REPORT_CAP);
    if (lcov === undefined) throw new RefusedError('vitest wrote no coverage report');
    const results = readCapped(join(dirname(tree), 'results.json'), REPORT_CAP);
    if (results === undefined) throw new RefusedError('vitest wrote no results');
    replaceFile(join(repo, 'coverage', 'lcov.info'), repoRelative(lcov, tree));
    replaceFile(join(repo, 'coverage', 'vitest-results.json'), results);
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
