// `factory ci weakened` (T162, AC-061): a test that passed at the merge base and is skipped, todo
// or missing at the head, or there runs in `fails` mode or passes only after a retry, is a finding named by its `test:<path>#<title>` waiver target; a deleted
// test file is one `test:<path>` finding. The base run is the base's tests on the base's sources,
// the head run the head's on the head's, both on T140's trees and runner with the head's install.
// A test failing at the head is not weakened: the test job reports it. CI reads no waivers, so a
// finding names the waiver that would cover it; `edges.ts`'s diff rules stay the early warning.
import { mergeBase, resolveCommit } from '../git/diff.js';
import { TEST_CONFIG, type TestConfig } from '../stations/edges.js';
import { cleanPass, inWorkspace, type Isolation, type TestRun } from './vitest-run.js';

/** Findings for tests that passed in `base` and did not run in `head`. */
export function judgeWeakened(
  base: TestRun,
  head: TestRun,
  headFiles: ReadonlySet<string>,
  headSha: string,
): string[] {
  const findings: string[] = [];
  const deleted = new Set<string>();
  const finding = (target: string, what: string) =>
    findings.push(`${target}: ${what}; a ${target} waiver for ${headSha} covers it`);
  // A test already in `fails` mode at the base did not pass there, so it is never counted again.
  for (const t of base.tests.filter((b) => b.status === 'passed' && !b.fails)) {
    if (!headFiles.has(t.file)) {
      if (!deleted.has(t.file)) finding(`test:${t.file}`, 'passed at the base, file deleted');
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
    finding(`test:${t.file}#${t.name}`, `passed at the base, ${state} at the head`);
  }
  return findings;
}

export function weakened(
  repo: string,
  base: string,
  head: string,
  options: { isolation: Isolation; env: NodeJS.ProcessEnv; config?: TestConfig },
): { findings: string[]; passed: number } {
  const { env } = options;
  const config = options.config ?? TEST_CONFIG;
  const to = resolveCommit(repo, head, env);
  const start = mergeBase(repo, base, to, env);
  return inWorkspace(repo, to, { isolation: options.isolation, config, env }, (ws) => {
    const headFiles = new Set(ws.write('head', to));
    ws.write('base', start);
    const baseRun = ws.test('base');
    const findings = judgeWeakened(baseRun, ws.test('head'), headFiles, to);
    return {
      findings,
      passed: baseRun.tests.filter((t) => t.status === 'passed' && !t.fails).length,
    };
  });
}
