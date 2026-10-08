// `factory ci coverage` (contracts/ci-checks.md, QG-3, research R13): the lines a pull request
// adds, from the safe diff, against Vitest's lcov report. Deleted lines never count. A changed
// source file the report does not list fails by name: a file no test loads has no coverage to
// measure, and guessing which of its lines are executable would let it pass. Test files are
// never sources; they are found with the weakened-test check's pattern, so T140 moves both.
import { realpathSync } from 'node:fs';
import { isAbsolute, posix, relative } from 'node:path';
import type { FileChange } from '../git/diff.js';
import { isTestFile, LOCAL_TEST_CONFIG } from '../stations/edges.js';

/** Sources the TypeScript profile measures. */
const SOURCE = /^src\/.+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION = /\.d\.[mc]?ts$/;
/** Named like a test, wherever it is. */
const TEST_NAME = /\.(?:test|spec)\.[mc]?[jt]sx?$/;

/** `file` relative to the repository, also when one of the two paths goes through a symlink. */
function inside(repo: string, file: string): string {
  const direct = relative(repo, file);
  return direct.startsWith('..') ? relative(realpathSync(repo), file) : direct;
}

/** Hits per line for each file in an lcov report, by path relative to the repository. */
export function parseLcov(text: string, repo: string): Map<string, Map<number, number>> {
  const files = new Map<string, Map<number, number>>();
  let current: Map<number, number> | undefined;
  for (const row of text.split('\n')) {
    if (row.startsWith('SF:')) {
      const sf = row.slice(3).trim();
      const path = posix.normalize((isAbsolute(sf) ? inside(repo, sf) : sf).replaceAll('\\', '/'));
      current = files.get(path) ?? new Map<number, number>();
      files.set(path, current);
    } else if (row.startsWith('DA:') && current !== undefined) {
      const [line, count] = row.slice(3).split(',').map(Number);
      if (Number.isSafeInteger(line) && Number.isFinite(count))
        current.set(line as number, Math.max(current.get(line as number) ?? 0, count as number));
    } else if (row.trim() === 'end_of_record') current = undefined;
  }
  return files;
}

export interface Coverage {
  covered: number;
  /** Added lines the report instruments. */
  total: number;
  /** Changed sources the report does not list, each with why. */
  problems: string[];
}

export function measureCoverage(
  changes: readonly FileChange[],
  report: ReadonlyMap<string, ReadonlyMap<number, number>>,
): Coverage {
  const result: Coverage = { covered: 0, total: 0, problems: [] };
  for (const change of changes) {
    if (change.type !== 'regular' || change.added.length === 0) continue;
    const lines = report.get(change.path);
    if (lines === undefined) {
      const { path } = change;
      if (isTestFile(path) || !SOURCE.test(path) || DECLARATION.test(path)) continue;
      const pattern = LOCAL_TEST_CONFIG.include.join(', ');
      result.problems.push(
        TEST_NAME.test(path)
          ? `${path} is outside the test paths (${pattern}), so it never runs; move it under tests/`
          : `${path}: not in the coverage report`,
      );
      continue;
    }
    for (const { line } of change.added) {
      const hits = lines.get(line);
      if (hits === undefined) continue;
      result.total += 1;
      if (hits > 0) result.covered += 1;
    }
  }
  return result;
}

/** At or above `threshold` percent, compared in whole numbers so 89.9% never rounds up. */
export const meetsThreshold = (c: Coverage, threshold: number) =>
  c.problems.length === 0 && (c.total === 0 || c.covered * 100 >= threshold * c.total);
