// Station edge rules (AC-057, AC-058, AC-061). Pure: callers pass the diff, reports and issues.
//
// - Split (AC-057): a Builder's `request_split` sends the item back to Plan, which files the work
//   as new work items marked `<!-- split-of #<item> -->` instead of opening a second PR.
// - Conflicts (AC-058): Integrate lists rebase conflicts it cannot resolve without changing
//   behaviour under `## Conflicts` in its report; any entry sends the item back to Build.
// - Tests (AC-061): a diff that skips, focuses, retries or deletes a test, or removes test
//   blocks or assertions, needs an Owner waiver. A flaky test is fixed, or quarantined: skipped
//   with `quarantine #<n>` naming an open issue the Owner can see, and still waived.
import type { CheckResult } from '../hooks/stop.js';
import type { Station } from '../model/types.js';
import { meaningful, section } from './checks/spec.js';

/** A gate failure naming the earliest station able to fix it (Evidence.failure). */
export interface Failure {
  station: Station;
  reason: string;
}

export function splitFailure(split: { task: string; reason: string }): Failure {
  return { station: 3, reason: `${split.task} returned to Plan: ${split.reason}` };
}

export interface SplitCheck extends CheckResult {
  missing: string[];
  /** Issues filed for the split work. */
  newItems: number[];
}

/** Plan's output after a split: new work items for the item, and no second PR for it. */
export function checkSplit(input: {
  item: number;
  branch: string;
  issues: readonly { number: number; body: string }[];
  prs: readonly { number: number; headRefName: string; title: string }[];
}): SplitCheck {
  const marker = `<!-- split-of #${String(input.item)} -->`;
  const newItems = input.issues.filter((i) => i.body.includes(marker)).map((i) => i.number);
  const missing: string[] = [];
  if (newItems.length === 0) missing.push(`no new work item marked ${marker}`);
  const title = new RegExp(`^#${String(input.item)}(?!\\d)`);
  const prs = input.prs.filter(
    (p) =>
      p.headRefName === input.branch ||
      p.headRefName.startsWith(`${input.branch}-`) ||
      title.test(p.title),
  );
  if (prs.length > 1)
    missing.push(
      `#${String(input.item)} has ${String(prs.length)} pull requests (${prs.map((p) => `#${String(p.number)}`).join(', ')}); a split opens none`,
    );
  return { complete: missing.length === 0, missing, newItems };
}

/** The route back to Build when Integrate's report lists conflicts, else undefined. */
export function conflictFailure(report: string): Failure | undefined {
  const lines = report.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const conflicts = (section(lines, 'Conflicts') ?? [])
    .filter((l) => /^\s*[-*]\s/.test(l) && meaningful(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter((l) => !/^none\.?$/i.test(l));
  if (conflicts.length === 0) return undefined;
  return {
    station: 4,
    reason: `rebase conflicts need a behaviour change: ${conflicts.join('; ')}`,
  };
}

/** One file of a diff (the safe diff of T138 gives a superset). */
export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  added: readonly string[];
  removed: readonly string[];
}

export interface TestChanges {
  ok: boolean;
  /** Changes that need an Owner waiver. */
  findings: string[];
  /** Changes that fail even with a waiver. */
  problems: string[];
  /** Issues named by quarantined tests. */
  quarantines: number[];
}

const TEST_FILE = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SKIP = /\b(?:it|test|describe)(?:\.\w+)*\.(?:skip|todo)\b|\bx(?:it|test|describe)\(/;
const ONLY = /\b(?:it|test|describe)(?:\.\w+)*\.only\b|\bf(?:it|describe)\(/;
const RETRY = /\bretry\s*:|\.retry\(/;
const BLOCK = /\b(?:it|test|describe)(?:\.\w+)*\(|\bx(?:it|test|describe)\(/g;
const ASSERT = /\bexpect(?:\.\w+)*\(|\bassert\b/g;
const QUARANTINE = /\bquarantine\s+#(\d+)/i;

const count = (lines: readonly string[], re: RegExp) =>
  lines.reduce((n, l) => n + (l.match(re)?.length ?? 0), 0);
const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

/** Checks a diff for weakened tests (AC-061). `waived`: a verified Owner waiver covers it. */
export function weakenedTests(
  diff: readonly DiffFile[],
  options: { waived: boolean; openIssues: ReadonlySet<number> },
): TestChanges {
  const findings: string[] = [];
  const problems: string[] = [];
  const quarantines: number[] = [];
  for (const f of diff) {
    if (!TEST_FILE.test(f.path)) continue;
    if (f.status === 'deleted') {
      findings.push(`${f.path}: deletes the test file`);
      continue;
    }
    for (const [i, raw] of f.added.entries()) {
      const line = raw.trim();
      if (SKIP.test(line)) {
        findings.push(`${f.path}: skips a test: ${line}`);
        const issue = QUARANTINE.exec(line)?.[1] ?? QUARANTINE.exec(f.added[i - 1] ?? '')?.[1];
        if (issue === undefined)
          problems.push(
            `${f.path}: skip without a quarantine issue (\`quarantine #<n>\`): ${line}`,
          );
        else if (!options.openIssues.has(Number(issue)))
          problems.push(`${f.path}: quarantine names #${issue}, which is not an open issue`);
        else quarantines.push(Number(issue));
      } else if (ONLY.test(line))
        findings.push(`${f.path}: focuses a test, skipping the others: ${line}`);
      else if (RETRY.test(line)) findings.push(`${f.path}: retries a test: ${line}`);
    }
    const blocks = count(f.removed, BLOCK) - count(f.added, BLOCK);
    if (blocks > 0) findings.push(`${f.path}: removes ${plural(blocks, 'test block')}`);
    const asserts = count(f.removed, ASSERT) - count(f.added, ASSERT);
    if (asserts > 0) findings.push(`${f.path}: removes ${plural(asserts, 'assertion')}`);
  }
  const ok = problems.length === 0 && (findings.length === 0 || options.waived);
  return { ok, findings, problems, quarantines };
}
