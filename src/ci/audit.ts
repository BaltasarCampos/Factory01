// `factory ci scan audit <base> <head>` (T169, contracts/ci-checks.md, FR-049, Owner decisions
// 2026-10-18): the pinned npm's `npm audit` on the merge base's and the head's lockfiles, failing
// only on advisories the pull request introduces:
// - An advisory is its ID (npm's `source`) and its package's name, never the version, so moving a
//   package between versions one advisory covers adds nothing. Existing advisories reach the Owner
//   through Dependabot and the weekly scan of main (T107).
// - It fails at or above the release's level (`audit.json`).
// - Each run sees only the commit's `package.json` and `package-lock.json`, alone in a temp folder,
//   against registry.npmjs.org, with npm's user and global config disabled and no `npm_config_*`
//   variable passed through, so no `.npmrc`, in the pull request or on the runner, changes the
//   registry or the level. A run that reports no audit, offline included, fails the check.
// An unchanged lockfile cannot introduce an advisory, so it is not audited at all.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RefusedError } from '../cli/env.js';
import { fileAt, mergeBase, safeGit } from '../git/diff.js';
import { pinnedTool } from './scan.js';
import { RELEASE_CI } from './test.js';

export const REGISTRY = 'https://registry.npmjs.org';
const LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];
const LOCK = 'package-lock.json';

interface Advisory {
  id: string;
  name: string;
  severity: string;
  title: string;
  url: string;
}

/** A field of npm's report as text: a string or a number, else empty. */
const text = (field: unknown) =>
  typeof field === 'string' || typeof field === 'number' ? String(field) : '';

/** The advisories `npm audit` reports for the lockfile in `work`, keyed by ID and package. */
function audit(npm: string, work: string, registry: string, path: string): Map<string, Advisory> {
  // Two files: npm refuses to load one file as both configs.
  const [user, global] = ['user-npmrc', 'global-npmrc'].map((name) => join(work, name));
  for (const file of [user, global]) writeFileSync(file ?? '', '');
  const result = spawnSync(
    npm,
    [
      ...['audit', '--json', '--package-lock-only', `--registry=${registry}/`],
      ...[`--userconfig=${user ?? ''}`, `--globalconfig=${global ?? ''}`],
    ],
    { cwd: work, env: { PATH: path, HOME: work }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  let report: { vulnerabilities?: Record<string, { via?: unknown[] }>; error?: unknown };
  try {
    report = JSON.parse(result.stdout) as typeof report;
  } catch {
    report = {};
  }
  // npm audit exits 1 when it finds vulnerabilities, so only the report decides.
  if (report.error !== undefined || report.vulnerabilities === undefined)
    throw new RefusedError(
      `npm audit reported no audit: ${(result.error?.message ?? result.stderr) || result.stdout}`.slice(
        0,
        2000,
      ),
    );
  const found = new Map<string, Advisory>();
  for (const entry of Object.values(report.vulnerabilities))
    for (const via of entry.via ?? []) {
      if (typeof via !== 'object' || via === null) continue;
      const v = via as Record<string, unknown>;
      const advisory = {
        ...{ id: text(v.source), name: text(v.name), severity: text(v.severity) },
        ...{ title: text(v.title), url: text(v.url) },
      };
      found.set(`${advisory.id}\0${advisory.name}`, advisory);
    }
  return found;
}

export function scanAudit(
  repo: string,
  base: string,
  head: string,
  env: NodeJS.ProcessEnv,
  registry = REGISTRY,
): { findings: string[]; base: number; head: number; unchanged: boolean } {
  const npm = pinnedTool('npm', env);
  const { level } = JSON.parse(readFileSync(join(RELEASE_CI, 'audit.json'), 'utf8')) as {
    level: string;
  };
  if (!LEVELS.includes(level)) throw new RefusedError(`audit.json: unknown level ${level}`);
  const start = mergeBase(repo, base, head, env);
  const blob = (commit: string) =>
    safeGit(repo, ['rev-parse', '--verify', '-q', `${commit}:${LOCK}`], env)
      .stdout.toString()
      .trim();
  if (blob(start) === blob(head)) return { findings: [], base: 0, head: 0, unchanged: true };
  if (fileAt(repo, head, LOCK, env) === undefined)
    throw new RefusedError(`no ${LOCK} at the head ${head.slice(0, 12)}: nothing to audit`);

  const advisories = (commit: string): Map<string, Advisory> => {
    const lock = fileAt(repo, commit, LOCK, env);
    if (lock === undefined) return new Map();
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'factory-audit-')));
    try {
      writeFileSync(join(work, LOCK), lock);
      writeFileSync(join(work, 'package.json'), fileAt(repo, commit, 'package.json', env) ?? '{}');
      return audit(npm, work, registry, env.PATH ?? '');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };
  const before = advisories(start);
  const after = advisories(head);
  const fails = (severity: string) => LEVELS.indexOf(severity) >= LEVELS.indexOf(level);
  const findings = [...after]
    .filter(([key, a]) => !before.has(key) && fails(a.severity))
    .map(
      ([, a]) => `${a.name}: ${a.severity} advisory ${a.url || a.id}, new at the head: ${a.title}`,
    );
  return { findings, base: before.size, head: after.size, unchanged: false };
}
