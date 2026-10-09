// Station edge rules (AC-057, AC-058, AC-061). Pure: callers pass the diff, reports and issues.
//
// - Split (AC-057): a Builder's `request_split` sends the item back to Plan, which files the work
//   as new work items marked `<!-- split-of #<item> -->` instead of opening a second PR.
//   The marker is trace information only: each new item still needs its own `owner:approved`.
// - Conflicts (AC-058): Integrate lists rebase conflicts it cannot resolve without changing
//   behaviour under `## Conflicts` in its report; before the Owner's merge, any entry sends the
//   item back to Build (after it, the transition table moves it on with an alert).
// - Tests (AC-061): a diff that skips, focuses, retries or deletes a test, removes test blocks
//   or assertions, or changes a setup file or test helper needs a signed waiver naming that test
//   (`test:<path>#<title>`) or its file (`test:<path>`). A flaky test is fixed, or quarantined:
//   skipped with `quarantine #<n>` naming an open issue the Owner can see, and still waived.
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

/** Which files are tests and which set them up, as in a Vitest config. */
export interface TestConfig {
  include: readonly string[];
  exclude: readonly string[];
  setupFiles: readonly string[];
  globalSetup: readonly string[];
}

/**
 * The TypeScript profile's test files (profile.yaml `tools.test.files`), hard-coded in the factory
 * and never read from the project, until T140 ships the release's Vitest config; a test fails
 * once that lands, so this constant cannot outlive it.
 */
export const LOCAL_TEST_CONFIG: TestConfig = {
  include: ['tests/**/*.test.ts'],
  exclude: [],
  setupFiles: [],
  globalSetup: [],
};

export interface TestFinding {
  message: string;
  /** The waiver target that covers it: `test:<path>#<title>`, or `test:<path>` for the file. */
  target: string;
  covered: boolean;
}

export interface TestChanges {
  ok: boolean;
  /** Changes that need a signed waiver, each with the target that covers it. */
  findings: TestFinding[];
  /** Changes that fail even with a waiver. */
  problems: string[];
  /** Issues named by quarantined tests. */
  quarantines: number[];
}

const glob = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split(/(\*\*\/|\*)/)
      .map((p) =>
        p === '**/' ? '(?:.*/)?' : p === '*' ? '[^/]*' : p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'),
      )
      .join('')}$`,
  );
const matches = (patterns: readonly string[], path: string) =>
  patterns.some((p) => glob(p).test(path));
const inTestPaths = (config: TestConfig, path: string) =>
  matches(config.include, path) && !matches(config.exclude, path);

/** Whether `path` is a test file; `factory ci coverage` uses the same pattern, so T140 moves both. */
export const isTestFile = (path: string, config: TestConfig = LOCAL_TEST_CONFIG) =>
  inTestPaths(config, path);

// An early warning only: the check that decides, at merge, runs Vitest at base and head with
// the JSON reporter and flags every test that passed at base but is skipped, todo or missing at
// head (T140, T068). Any `.skip(` call counts, so `ctx.skip()` inside a test does too.
const SKIP =
  /\b(?:it|test|describe)(?:\.\w+)*\.(?:skipIf|runIf|todo)\b|\.skip\b|\bx(?:it|test|describe)\(/;
const ONLY = /\b(?:it|test|describe)(?:\.\w+)*\.only\b|\bf(?:it|describe)\(/;
const FAILS = /\b(?:it|test)(?:\.\w+)*\.fails\b/;
const RETRY = /\bretry\s*:|\.retry\(/;
const BLOCK = /\b(?:it|test|describe)(?:\.\w+)*\(|\bx(?:it|test|describe)\(/g;
const CALL = /\b(?:it|test)(?:\.\w+)*\(/;
const TITLE = /\b[xf]?(?:it|test|describe)(?:\.\w+)*\(\s*(['"`])(.*?)\1/;
const ASSERT = /\bexpect(?:\.\w+)*\(|\bassert\b/g;
const QUARANTINE = /\bquarantine\s+#(\d+)/i;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

const count = (lines: readonly string[], re: RegExp) =>
  lines.reduce((n, l) => n + (l.match(re)?.length ?? 0), 0);
const titles = (lines: readonly string[]) =>
  lines.flatMap((l) => {
    const t = TITLE.exec(l)?.[2];
    return t === undefined ? [] : [t];
  });

/** The repository file a relative import names (`./x.js` is `./x.ts` in TypeScript sources). */
function resolveImport(from: string, spec: string, files: ReadonlyMap<string, string>) {
  const parts = from.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  const path = parts.join('/');
  const base = path.replace(/\.[cm]?js$/, '');
  return [path, `${base}.ts`, `${base}.tsx`, `${path}/index.ts`].find((p) => files.has(p));
}

/**
 * Test helpers that can weaken an existing test. Helpers are found over base and head together:
 * files in the test paths with no `it`/`test` call, and, as a fixed point, every file outside
 * them whose importers are all tests or helpers (a module the app also imports is production
 * code under test, not a helper). Only those that exist at the base and that a test at the base
 * reaches, directly or through other helpers, are returned: a new helper cannot weaken an
 * earlier test, and a new module that only its new test imports is not one yet. A helper deleted
 * at head is still returned from the base.
 */
export function testHelpers(
  base: ReadonlyMap<string, string>,
  head: ReadonlyMap<string, string>,
  config: TestConfig = LOCAL_TEST_CONFIG,
): Set<string> {
  const helpers = new Set<string>();
  const tests = new Set<string>();
  const importers = new Map<string, Set<string>>();
  const baseImports = new Map<string, string[]>();
  for (const files of [base, head])
    for (const [path, text] of files) {
      for (const m of text.matchAll(IMPORT)) {
        const target = resolveImport(path, m[1] ?? '', files);
        if (target === undefined) continue;
        importers.set(target, (importers.get(target) ?? new Set()).add(path));
        if (files === base) baseImports.set(path, [...(baseImports.get(path) ?? []), target]);
      }
    }
  for (const path of new Set([...base.keys(), ...head.keys()])) {
    if (!inTestPaths(config, path)) continue;
    const text = head.get(path) ?? base.get(path) ?? '';
    (CALL.test(text) ? tests : helpers).add(path);
  }
  // Greatest fixed point, so helpers that import each other count too: start from every
  // imported file outside the test paths, then drop any with an importer that is neither.
  const candidates = new Set([...importers.keys()].filter((p) => !tests.has(p) && !helpers.has(p)));
  for (let shrank = true; shrank;) {
    shrank = false;
    for (const path of candidates) {
      const by = importers.get(path) ?? new Set<string>();
      if ([...by].some((i) => !tests.has(i) && !helpers.has(i) && !candidates.has(i))) {
        candidates.delete(path);
        shrank = true;
      }
    }
  }
  for (const path of candidates) helpers.add(path);

  const reached = new Set<string>();
  const visit = (path: string) => {
    for (const target of baseImports.get(path) ?? [])
      if (helpers.has(target) && !reached.has(target)) {
        reached.add(target);
        visit(target);
      }
  };
  for (const [path, text] of base) if (inTestPaths(config, path) && CALL.test(text)) visit(path);
  return reached;
}

/**
 * Checks a diff for weakened tests (AC-061). Each finding names its waiver target and whether one
 * of `waivers` (targets of verified records) covers it; a file-wide `test:<path>` covers every
 * finding in that file. CI runs this as an early warning; `factory merge` decides.
 */
export function weakenedTests(
  diff: readonly DiffFile[],
  options: {
    waivers: ReadonlySet<string>;
    openIssues: ReadonlySet<number>;
    helpers: ReadonlySet<string>;
    config?: TestConfig;
  },
): TestChanges {
  const config = options.config ?? LOCAL_TEST_CONFIG;
  const findings: TestFinding[] = [];
  const problems: string[] = [];
  const quarantines: number[] = [];
  for (const f of diff) {
    const fileTarget = `test:${f.path}`;
    const find = (message: string, title?: string) => {
      const target = title === undefined ? fileTarget : `${fileTarget}#${title}`;
      const covered = options.waivers.has(target) || options.waivers.has(fileTarget);
      findings.push({ message: `${f.path}: ${message}`, target, covered });
    };
    if (matches([...config.setupFiles, ...config.globalSetup], f.path)) {
      find('changes a test setup file');
      continue;
    }
    if (options.helpers.has(f.path)) {
      find(f.status === 'deleted' ? 'deletes a test helper' : 'changes a test helper');
      continue;
    }
    if (!inTestPaths(config, f.path)) continue;
    if (f.status === 'deleted') {
      find('deletes the test file');
      continue;
    }
    for (const [i, raw] of f.added.entries()) {
      const line = raw.trim();
      const title = TITLE.exec(line)?.[2];
      if (SKIP.test(line)) {
        find(`skips a test: ${line}`, title);
        const issue = QUARANTINE.exec(line)?.[1] ?? QUARANTINE.exec(f.added[i - 1] ?? '')?.[1];
        if (issue === undefined)
          problems.push(
            `${f.path}: skip without a quarantine issue (\`quarantine #<n>\`): ${line}`,
          );
        else if (!options.openIssues.has(Number(issue)))
          problems.push(`${f.path}: quarantine names #${issue}, which is not an open issue`);
        else quarantines.push(Number(issue));
      } else if (ONLY.test(line)) find(`focuses a test, skipping the others: ${line}`, title);
      else if (FAILS.test(line)) find(`inverts a test (it passes when it fails): ${line}`, title);
      else if (RETRY.test(line)) find(`retries a test: ${line}`, title);
    }
    const kept = titles(f.added);
    const gone = titles(f.removed).filter((t) => {
      const at = kept.indexOf(t);
      if (at !== -1) kept.splice(at, 1);
      return at === -1;
    });
    for (const t of gone) find(`removes test block '${t}'`, t);
    const untitled = count(f.removed, BLOCK) - count(f.added, BLOCK) - gone.length;
    if (untitled > 0) find(`removes ${plural(untitled, 'test block')}`);
    const asserts = count(f.removed, ASSERT) - count(f.added, ASSERT);
    // A removed assertion inside an unchanged test cannot name its test from the diff.
    if (asserts > 0) find(`removes ${plural(asserts, 'assertion')}`);
  }
  const ok = problems.length === 0 && findings.every((f) => f.covered);
  return { ok, findings, problems, quarantines };
}

const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`;
