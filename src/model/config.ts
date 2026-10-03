// `.factory/config` loader. Every rule is from data-model.md § Project config.
//
// YAML is read with the failsafe schema: every scalar arrives as a string, so a 40-hex commit
// made only of digits cannot turn into a number and `agents: no` cannot turn into a boolean.
import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { parseReleasePin } from './naming.js';
import type { AgentsMode, ProjectConfig } from './types.js';

/** Limits shipped with the factory release; projects may only make them stricter. */
export interface ReleaseLimits {
  sizeLimitLines: number;
  coverageMin: number;
}

export const RELEASE_LIMITS: ReleaseLimits = { sizeLimitLines: 400, coverageMin: 90 };

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`invalid .factory/config:\n  ${problems.join('\n  ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const KEYS = [
  'factory_release',
  'baseline',
  'agents',
  'profile',
  'repo',
  'inbox_issue',
  'parallel_sessions',
  'retry_limit',
  'size_limit_lines',
  'coverage_min',
] as const;
type Key = (typeof KEYS)[number];

const COMMIT = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const POSITIVE_INT = /^[1-9]\d*$/;

export function parseConfig(text: string, release: ReleaseLimits = RELEASE_LIMITS): ProjectConfig {
  const doc = parseDocument(text, { schema: 'failsafe', uniqueKeys: true });
  if (doc.errors.length > 0) throw new ConfigError(doc.errors.map((e) => e.message));
  const raw: unknown = doc.toJS();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(['config must be a YAML mapping']);
  }

  const problems: string[] = [];
  const fields = new Map<string, string>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(KEYS as readonly string[]).includes(key)) problems.push(`${key}: unknown key`);
    else if (typeof value !== 'string') problems.push(`${key}: must be a single value`);
    else fields.set(key, value);
  }
  const get = (key: Key): string | undefined => fields.get(key);

  const positive = (key: Key, fallback: number): number => {
    const value = get(key);
    if (value === undefined) return fallback;
    if (!POSITIVE_INT.test(value)) {
      problems.push(`${key}: must be a positive integer`);
      return fallback;
    }
    return Number(value);
  };

  const pinText = get('factory_release');
  const pin = pinText === undefined ? undefined : parseReleasePin(pinText);
  if (pinText === undefined) problems.push('factory_release: required');
  else if (!pin) problems.push('factory_release: must be <tag>@<40-hex sha>, e.g. v1.0.0@3f9a…');

  const baseline = get('baseline');
  if (baseline !== undefined && !COMMIT.test(baseline))
    problems.push('baseline: must be a 40-hex commit');

  const agents = get('agents');
  if (agents !== undefined && agents !== 'cloud' && agents !== 'local') {
    problems.push('agents: must be cloud or local');
  }

  const profile = get('profile') ?? 'typescript';
  if (profile !== 'typescript') problems.push('profile: only typescript is approved');

  const repo = get('repo');
  if (repo === undefined) problems.push('repo: required');
  else if (!REPO.test(repo)) problems.push('repo: must be owner/name');

  const inboxText = get('inbox_issue');
  if (inboxText === undefined) problems.push('inbox_issue: required');
  const inbox_issue = positive('inbox_issue', 0);

  const parallel_sessions = positive('parallel_sessions', 1);
  const retry_limit = positive('retry_limit', 3);

  const size_limit_lines = positive('size_limit_lines', release.sizeLimitLines);
  if (size_limit_lines > release.sizeLimitLines) {
    problems.push(
      `size_limit_lines: may only be lowered below the release's limit (${String(release.sizeLimitLines)})`,
    );
  }

  const coverage_min = positive('coverage_min', release.coverageMin);
  if (coverage_min < release.coverageMin) {
    problems.push(
      `coverage_min: may only be raised above the release's floor (${String(release.coverageMin)})`,
    );
  } else if (coverage_min > 100) {
    problems.push('coverage_min: must be at most 100');
  }

  if (problems.length > 0 || !pin || repo === undefined) throw new ConfigError(problems);

  return {
    factory_release: pin,
    ...(baseline === undefined ? {} : { baseline }),
    ...(agents === undefined ? {} : { agents: agents as AgentsMode }),
    profile: 'typescript',
    repo,
    inbox_issue,
    parallel_sessions,
    retry_limit,
    size_limit_lines,
    coverage_min,
  };
}

export async function loadConfig(path: string, release?: ReleaseLimits): Promise<ProjectConfig> {
  return parseConfig(await readFile(path, 'utf8'), release);
}
