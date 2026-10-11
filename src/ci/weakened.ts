// `factory ci weakened` (T162, AC-061): a test that passed at the merge base and is skipped, todo
// or missing at the head, or there runs in `fails` mode or passes only after a retry, is a finding named by its `test:<path>#<title>` waiver target; a deleted
// test file is one `test:<path>` finding. The base run is the base's tests on the base's sources,
// the head run the head's on the head's, both on T140's trees and runner with the head's install.
// A test failing at the head is not weakened: the test job reports it. CI reads no waivers, so a
// finding names the waiver that would cover it; `edges.ts`'s diff rules stay the early warning.
import { mergeBase, resolveCommit } from '../git/diff.js';
import { TEST_CONFIG, type TestConfig } from '../stations/edges.js';
import { cleanPass, inWorkspace, type Isolation, type TestRun } from './vitest-run.js';

/** A test that passed at the base and did not run cleanly at the head. */
export interface WeakFinding {
  /** `test:<path>#<title>`, or `test:<path>` for a deleted file: the waiver that names it. */
  target: string;
  /** The path and title apart, so a `#` in either is never read as the split. */
  file: string;
  title?: string;
  what: string;
}

/**
 * Whether a `test:` waiver covers a finding: its target exactly, or exactly `test:<path>` of the
 * finding's own path. No prefixes or patterns (T151).
 */
export const covers = (waives: string, finding: WeakFinding): boolean =>
  waives === finding.target || waives === `test:${finding.file}`;

/** The line CI prints for a finding, naming the waiver that would cover it. */
export const findingLine = (f: WeakFinding, headSha: string): string =>
  `${f.target}: ${f.what}; a ${f.target} waiver for ${headSha} covers it`;

/** Findings for tests that passed in `base` and did not run in `head`. */
export function judgeWeakened(
  base: TestRun,
  head: TestRun,
  headFiles: ReadonlySet<string>,
): WeakFinding[] {
  const findings: WeakFinding[] = [];
  const deleted = new Set<string>();
  // A test already in `fails` mode at the base did not pass there, so it is never counted again.
  for (const t of base.tests.filter((b) => b.status === 'passed' && !b.fails)) {
    if (!headFiles.has(t.file)) {
      if (!deleted.has(t.file))
        findings.push({
          target: `test:${t.file}`,
          file: t.file,
          what: 'passed at the base, file deleted',
        });
      deleted.add(t.file);
      continue;
    }
    if (head.loadFailed.has(t.file)) continue;
    const now = head.tests.find((h) => h.file === t.file && h.name === t.name);
    if (now?.status === 'failed' || (now !== undefined && cleanPass(now))) continue;
    const state =
      now === undefined
        ? 'missing'
        : now.fails
          ? 'in fails mode'
          : now.retries > 0
            ? `passed only after ${String(now.retries)} ${now.retries === 1 ? 'retry' : 'retries'}`
            : now.status;
    findings.push({
      target: `test:${t.file}#${t.name}`,
      file: t.file,
      title: t.name,
      what: `passed at the base, ${state} at the head`,
    });
  }
  return findings;
}

export function weakened(
  repo: string,
  base: string,
  head: string,
  options: { isolation: Isolation; env: NodeJS.ProcessEnv; config?: TestConfig },
): { findings: WeakFinding[]; head: string; passed: number } {
  const { env } = options;
  const config = options.config ?? TEST_CONFIG;
  const to = resolveCommit(repo, head, env);
  const start = mergeBase(repo, base, to, env);
  return inWorkspace(repo, to, { isolation: options.isolation, config, env }, (ws) => {
    const headFiles = new Set(ws.write('head', to));
    ws.write('base', start);
    const baseRun = ws.test('base');
    const findings = judgeWeakened(baseRun, ws.test('head'), headFiles);
    return {
      findings,
      head: to,
      passed: baseRun.tests.filter((t) => t.status === 'passed' && !t.fails).length,
    };
  });
}
