// `factory ci scan semgrep|gitleaks|markers <base> <head>` (T141, contracts/ci-checks.md, FR-049,
// Owner decisions 2026-10-09/10). Neither tool runs pull request code, so neither needs the
// sandbox, but nothing in the pull request may silence them:
// - Both come from PATH at the version pinned in the release's tools.json; any other refuses.
// - semgrep runs the release's rules with --disable-nosem and --no-git-ignore on raw-blob trees of
//   the merge base and the head, which hold no Semgrep or .gitignore file of the project's; a
//   finding is new when its rule, path and matched text appear more often at the head than at the
//   base. (Semgrep honours git's ignore rules when its tree sits inside a git work tree.)
// - gitleaks runs the release's config on each commit's added lines (for a merge, only the lines
//   new against every parent), written in order as `<sha>/<path>`, with gitleaks:allow ignored
//   and its ignore path an empty folder. The default config's global path allowlist (lockfiles,
//   node_modules, any path containing gitleaks.toml) cannot be switched off, and the pull request
//   names its files, so the same lines are also scanned as `<sha>/<n>`.
// - markers: every added line that would silence a tool, if one honoured it, is a finding too,
//   outside specs/ and Markdown, which the tools never read as code.
// Each finding names the `finding:<rule>@<path>:<line>` waiver that would cover it.
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, relative } from 'node:path';
import { RefusedError } from '../cli/env.js';
import { mergeBase, safeDiff, safeGit, type FileChange } from '../git/diff.js';
import { factoryRoot } from './sandbox.js';
import { writeTree } from './vitest-run.js';

const RELEASE_CI = join(factoryRoot(), 'factory', 'profiles', 'typescript', 'ci');
const SPAWN = { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 } as const;

const finding = (rule: string, path: string, line: number, what: string) => {
  const target = `finding:${rule}@${path}:${String(line)}`;
  return `${target}: ${what}; a ${target} waiver covers it`;
};

/** The tool on PATH, refused unless its `--version` names the release's pin. */
export function pinnedTool(name: 'semgrep' | 'gitleaks', env: NodeJS.ProcessEnv): string {
  const pins = JSON.parse(readFileSync(join(RELEASE_CI, 'tools.json'), 'utf8')) as Record<
    string,
    string
  >;
  const pin = pins[name] ?? '';
  const path = (env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, name))
    .find((file) => {
      try {
        accessSync(file, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  if (path === undefined)
    throw new RefusedError(`${name} not found on PATH; the release pins ${name} ${pin}`);
  const version = /\d+\.\d+\.\d+/.exec(spawnSync(path, ['--version'], { env, ...SPAWN }).stdout);
  if (version?.[0] !== pin)
    throw new RefusedError(
      `${path} is ${name} ${version?.[0] ?? 'of an unknown version'}; the release pins ${pin}`,
    );
  return path;
}

/** Runs `fn` in a fresh temp folder, removed afterwards. */
function inTemp<T>(fn: (work: string) => T): T {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'factory-scan-')));
  try {
    return fn(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function run(tool: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(tool, args, { cwd, env, ...SPAWN });
  if (result.status !== 0)
    throw new RefusedError(
      `${tool} failed: ${(result.error?.message ?? result.stderr) || result.stdout}`.slice(0, 2000),
    );
  return result.stdout;
}

interface Match {
  rule: string;
  path: string;
  line: number;
  text: string;
  message: string;
}

interface SemgrepResult {
  check_id: string;
  path: string;
  start: { line: number; offset: number };
  end: { offset: number };
  extra: { message?: string };
}

function semgrepMatches(tool: string, tree: string, env: NodeJS.ProcessEnv): Match[] {
  mkdirSync(tree, { recursive: true });
  copyFileSync(join(RELEASE_CI, 'semgrepignore'), join(tree, '.semgrepignore'));
  const out = run(
    tool,
    [
      ...['scan', '--config', join(RELEASE_CI, 'semgrep.yml'), '--json', '--disable-nosem'],
      ...['--no-git-ignore', '--metrics=off', '--disable-version-check', '--quiet', '.'],
    ],
    tree,
    env,
  );
  return (JSON.parse(out) as { results: SemgrepResult[] }).results.map((r) => ({
    // Semgrep prefixes each rule id with the config's path; the release's ids have no dots.
    rule: r.check_id.slice(r.check_id.lastIndexOf('.') + 1),
    path: r.path,
    line: r.start.line,
    // Semgrep's own copy of the lines needs a login; the bytes it matched are in the tree.
    text: readFileSync(join(tree, r.path)).subarray(r.start.offset, r.end.offset).toString(),
    message: r.extra.message ?? '',
  }));
}

export function scanSemgrep(
  repo: string,
  base: string,
  head: string,
  env: NodeJS.ProcessEnv,
): { findings: string[]; base: number; head: number } {
  const tool = pinnedTool('semgrep', env);
  const start = mergeBase(repo, base, head, env);
  return inTemp((work) => {
    const matches = (name: string, commit: string) => {
      writeTree(repo, commit, join(work, name), (path) => basename(path) !== '.gitignore', env);
      return semgrepMatches(tool, join(work, name), env);
    };
    const before = matches('base', start);
    const after = matches('head', head);
    const key = (m: Match) => JSON.stringify([m.rule, m.path, m.text]);
    const counts = new Map<string, number>();
    for (const m of before) counts.set(key(m), (counts.get(key(m)) ?? 0) + 1);
    const groups = new Map<string, Match[]>();
    for (const m of after) groups.set(key(m), [...(groups.get(key(m)) ?? []), m]);
    const findings = [...groups.values()].flatMap((group) => {
      const at = counts.get(key(group[0] as Match)) ?? 0;
      // Which copies are new cannot be told apart; the last ones are named.
      return group
        .sort((a, b) => a.line - b.line)
        .slice(at)
        .map((m) =>
          finding(
            m.rule,
            m.path,
            m.line,
            `${m.message} (${String(group.length)} at the head, ${String(at)} at the base)`,
          ),
        );
    });
    return { findings, base: before.length, head: after.length };
  });
}

/** Where a line that gitleaks scanned came from. */
interface Origin {
  sha: string;
  path: string;
  lines: number[];
}

/** A commit's added lines by path; for a merge, only those added against every parent. */
function addedByCommit(repo: string, sha: string, parents: string[], env: NodeJS.ProcessEnv) {
  if (parents.length === 0) throw new RefusedError(`${sha} has no parent`);
  const diffs = parents.map((p) => new Map(safeDiff(repo, p, sha, env).map((c) => [c.path, c])));
  const added = new Map<string, { lines: number[]; text: string[] }>();
  for (const [path, change] of diffs[0] ?? []) {
    const all = diffs.map((d) => d.get(path)).filter((c): c is FileChange => c !== undefined);
    if (all.length < diffs.length || change.status === 'deleted') continue;
    if (change.type === 'binary') {
      // No lines to scan, but path rules (a `.p12` file, say) still apply.
      added.set(path, { lines: [0], text: ['(binary file)'] });
      continue;
    }
    const kept = change.added.filter((l) =>
      all.every((c) => c.added.some((a) => a.line === l.line)),
    );
    if (kept.length > 0)
      added.set(path, { lines: kept.map((l) => l.line), text: kept.map((l) => l.text) });
  }
  return added;
}

interface Leak {
  RuleID: string;
  File: string;
  StartLine: number;
}

export function scanGitleaks(
  repo: string,
  base: string,
  head: string,
  env: NodeJS.ProcessEnv,
): { findings: string[]; commits: number } {
  const tool = pinnedTool('gitleaks', env);
  const start = mergeBase(repo, base, head, env);
  const listing = safeGit(repo, ['rev-list', '--reverse', '--parents', `${start}..${head}`], env);
  if (listing.status !== 0) throw new RefusedError(`cannot list ${start}..${head}`);
  const commits = listing.stdout.toString().split('\n').filter(Boolean);
  return inTemp((work) => {
    const origins = new Map<string, Origin>();
    for (const row of commits) {
      const [sha = '', ...parents] = row.split(' ');
      let n = 0;
      for (const [path, { lines, text }] of addedByCommit(repo, sha, parents, env)) {
        n += 1;
        for (const name of [join('named', sha, path), join('plain', sha, String(n))]) {
          mkdirSync(dirname(join(work, name)), { recursive: true });
          writeFileSync(join(work, name), `${text.join('\n')}\n`);
          origins.set(name, { sha, path, lines });
        }
      }
    }
    mkdirSync(join(work, 'empty'));
    const leaks = ['named', 'plain'].flatMap((layout) => {
      const report = join(work, `${layout}.json`);
      run(
        tool,
        [
          ...['dir', join(work, layout), '--config', join(RELEASE_CI, 'gitleaks.toml')],
          ...['--gitleaks-ignore-path', join(work, 'empty'), '--ignore-gitleaks-allow'],
          ...['--no-banner', '--redact', '--exit-code', '0'],
          ...['--report-format', 'json', '--report-path', report],
        ],
        join(work, 'empty'),
        env,
      );
      return JSON.parse(readFileSync(report, 'utf8')) as Leak[];
    });
    const findings = new Set<string>();
    for (const leak of leaks) {
      const origin = origins.get(relative(work, leak.File));
      if (origin === undefined)
        throw new RefusedError(`gitleaks named an unknown file ${leak.File}`);
      const line = origin.lines[leak.StartLine - 1] ?? origin.lines[0] ?? 0;
      findings.add(finding(leak.RuleID, origin.path, line, `secret added in ${origin.sha}`));
    }
    return { findings: [...findings], commits: commits.length };
  });
}

/** Comments that would silence a tool if it honoured them. */
const MARKER =
  /gitleaks:allow|\bnosem(?:grep)?\b|eslint-disable|@ts-(?:ignore|nocheck|expect-error)/g;

export function scanMarkers(
  repo: string,
  base: string,
  head: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const start = mergeBase(repo, base, head, env);
  const prose = (path: string) => path.startsWith('specs/') || /\.(?:md|markdown)$/i.test(path);
  return safeDiff(repo, start, head, env)
    .filter((change) => !prose(change.path))
    .flatMap((change) =>
      change.added.flatMap((l) =>
        [...new Set(l.text.match(MARKER))].map((marker) =>
          finding(marker, change.path, l.line, `${marker} added`),
        ),
      ),
    );
}
