// Per-branch merge rules (data-model.md § Pull request merge checks, T143): what `factory merge`
// checks on the laptop for each kind of pull request, from the checked commit and main's verified
// head alone, never a local branch. Every diff is the safe diff from the merge base.
//
// Project rules, by head branch: a work item `claude/<issue>-<slug>` and `claude/define` touch no
// protected path, except that Define's may change the brief (T173); `factory/upgrade-<tag>` pins
// a signed release whose protected files it installs exactly; `claude/factory-log` only appends
// regular text under the log paths. Any other branch is refused, except in the factory
// repository, identified positively by its origin. There, before it adopts itself, every branch
// gets the factory-repository rule; after, the project rules come first and that rule covers only
// the rest (`coach/<yyyy-Www>`, the Owner's own branches).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ReleaseKeys } from '../approvals/keys.js';
import { verifyGate, type LabelAdd, type PostedComment } from '../approvals/verify.js';
import { checkAppendOnly, LOG_BRANCH } from '../ci/append-only.js';
import { mergeBase, safeDiff, safeGit } from '../git/diff.js';
import {
  BRIEF_PATH,
  coversHashed,
  isHashed,
  isProtected,
  manifestMismatches,
} from '../install/manifest.js';
import { parseConfig } from '../model/config.js';
import { isSlug } from '../model/naming.js';
import { verifiedManifest, verifyReleaseTag } from '../release/tag.js';

const CONFIG = '.factory/config';

export type RuleName =
  'item' | 'define' | 'upgrade' | 'factory-log' | 'factory-repository' | 'none';

export interface RuleResult {
  /** The rule that applied; `none` when no rule takes the branch. */
  rule: RuleName;
  /** Why the pull request may not merge; empty when the rule passes. */
  problems: string[];
  /** The work item, for the approval chain `factory merge` checks next. */
  issue?: number;
}

/** The pull request as `factory merge` read it from GitHub. */
export interface PullRequest {
  number: number;
  comments: readonly PostedComment[];
  labelAdds: readonly LabelAdd[];
}

export interface MergeRulesInput {
  /** The project clone, fetched by the caller. */
  repo: string;
  /** The pull request's head branch. */
  branch: string;
  /** The checked commit, resolved from `origin/<branch>` as fetched. */
  head: string;
  /** Main's head, verified as Owner-signed (src/git/history.ts). */
  main: string;
  /** The key lists of the release pinned at `main` (`mainKeys`), tag-checked on the laptop. */
  keys: ReleaseKeys;
  /** The laptop's own key lists (`laptopKeys`). */
  laptopKeys: ReleaseKeys;
  secondCopy: string | undefined;
  /** The factory clone releases are read from (`factorySource`). */
  factory: string;
  /** `owner/repo` the trusted release names as its source (`releaseSource`). */
  factoryRepo: string | undefined;
  pr?: PullRequest;
  env?: NodeJS.ProcessEnv;
}

/** `owner/repo` of a GitHub remote URL in its SSH or HTTPS form; undefined otherwise. */
export function originRepo(url: string): string | undefined {
  const m =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return m?.[1];
}

/** The repository a release names as its own source: `FACTORY_REPO` in its CI template. */
export function releaseSource(factory: string, sha: string): string | undefined {
  const shown = spawnSync('git', ['show', `${sha}:factory/workflows/ci.yml`], {
    cwd: factory,
    encoding: 'utf8',
  });
  if (shown.status !== 0) return undefined;
  return /^\s*FACTORY_REPO:\s*([\w.-]+\/[\w.-]+)\s*$/m.exec(shown.stdout)?.[1];
}

/** Paths an item, or Define's, pull request may not touch, and a symlink over a guarded folder. */
const guarded = (path: string, define = false) =>
  isProtected(path, { define }) || coversHashed(path);

export function mergeRules(input: MergeRulesInput): RuleResult {
  const env = input.env ?? process.env;
  const git = (args: readonly string[]) => safeGit(input.repo, args, env);
  const origin = git(['remote', 'get-url', 'origin']).stdout.toString('utf8');
  const isFactory = input.factoryRepo !== undefined && originRepo(origin) === input.factoryRepo;
  const adopted = git(['cat-file', '-e', `${input.main}:${CONFIG}`]).status === 0;
  const changes = () =>
    safeDiff(input.repo, mergeBase(input.repo, input.main, input.head, env), input.head, env);

  if (isFactory && !adopted) return factoryRule(changes());
  const { branch } = input;
  const item = /^claude\/([1-9]\d*)-(.+)$/.exec(branch);
  if (item !== null && isSlug(item[2] ?? '')) {
    const problems = pathRule(changes(), false);
    return { rule: 'item', problems, issue: Number(item[1]) };
  }
  if (branch === 'claude/define') return { rule: 'define', problems: pathRule(changes(), true) };
  if (branch === LOG_BRANCH) {
    const options = { logBranch: true, env };
    return {
      rule: 'factory-log',
      problems: checkAppendOnly(input.repo, input.main, input.head, options),
    };
  }
  if (branch.startsWith('factory/upgrade-'))
    return { rule: 'upgrade', problems: upgradeRule(input, changes()) };
  if (isFactory && !branch.startsWith('claude/')) return factoryRule(changes());
  return { rule: 'none', problems: [`no merge rule takes branch ${branch}`] };
}

export function pathRule(changes: ReturnType<typeof safeDiff>, define: boolean): string[] {
  const problems = changes
    .filter((c) => guarded(c.path, define))
    .map((c) =>
      c.path === BRIEF_PATH
        ? `${c.path}: the project brief, which only a Define pull request may change`
        : `${c.path}: a protected path, which no item or Define pull request may change`,
    );
  // Define may change the brief, but only as a regular file (T173).
  const brief = changes.find((c) => c.path === BRIEF_PATH && c.newMode !== undefined);
  if (define && brief !== undefined && !['100644', '100755'].includes(brief.newMode ?? ''))
    problems.push(`${BRIEF_PATH}: not a regular file (mode ${brief.newMode ?? ''})`);
  return problems;
}

function factoryRule(changes: ReturnType<typeof safeDiff>): RuleResult {
  const problems = changes
    .filter((c) => guarded(c.path))
    .map(
      (c) =>
        `${c.path}: the factory's own workflows and self-protection files change only when the Owner copies them into place with a signed commit`,
    );
  return { rule: 'factory-repository', problems };
}

function upgradeRule(input: MergeRulesInput, changes: ReturnType<typeof safeDiff>): string[] {
  const problems: string[] = [];
  const show = (ref: string) => {
    const shown = safeGit(input.repo, ['show', `${ref}:${CONFIG}`], input.env ?? process.env);
    return shown.status === 0 ? shown.stdout.toString('utf8') : undefined;
  };
  const before = show(input.main);
  const after = show(input.head);
  let pin;
  try {
    pin = parseConfig(after ?? '').factory_release;
  } catch (err) {
    return [`${CONFIG} at the head: ${err instanceof Error ? err.message : String(err)}`];
  }
  const tag = input.branch.slice('factory/upgrade-'.length);
  if (tag !== pin.tag)
    problems.push(`${input.branch} does not name the release it pins, ${pin.tag}`);
  const withoutPin = (text: string | undefined) =>
    (text ?? '')
      .split('\n')
      .filter((l) => !l.startsWith('factory_release:'))
      .join('\n');
  if (before === undefined || withoutPin(before) !== withoutPin(after))
    problems.push(`${CONFIG} may change only in its factory_release line`);
  for (const c of changes)
    if (!isHashed(c.path) && c.path !== CONFIG)
      problems.push(`${c.path}: outside the protected set and ${CONFIG}`);

  // The tag must verify with main's pinned lists and with the laptop's own.
  try {
    verifyReleaseTag(input.factory, pin.tag, pin.sha, input.laptopKeys);
  } catch (err) {
    problems.push(
      `the laptop's own key lists: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const manifest = verifiedManifest(input.factory, pin, input.keys);
    const head = protectedAt(input);
    problems.push(...head.problems, ...manifestMismatches(manifest.files, head.files));
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }

  const waives = `check:guardrail-change@${pin.tag}@${pin.sha}`;
  let project: string;
  try {
    project = parseConfig(before ?? '').repo;
  } catch (err) {
    return [...problems, `${CONFIG} on main: ${err instanceof Error ? err.message : String(err)}`];
  }
  const verdict =
    input.pr === undefined
      ? { ok: false as const, reason: 'no pull request comments were read' }
      : verifyGate({
          keys: input.keys,
          secondCopy: input.secondCopy,
          expected: {
            ...{ repo: project, issue: input.pr.number, gate: 'waiver' },
            ...{ branch: input.branch, waives },
          },
          comments: input.pr.comments,
          labelAdds: input.pr.labelAdds,
        });
  if (!verdict.ok) problems.push(`no verified waiver ${waives}: ${verdict.reason}`);
  return problems;
}

/**
 * SHA-256 of every hashed protected file in the head's tree, and why any is not a regular file.
 * Each `ls-tree -z` entry is `<mode> <type> <oid>` and a tab, then the whole path, which may hold
 * a tab itself; a symlink or gitlink at a hashed path is refused, never hashed by its target.
 */
function protectedAt(input: MergeRulesInput): {
  files: Record<string, string>;
  problems: string[];
} {
  const env = input.env ?? process.env;
  const listed = safeGit(input.repo, ['ls-tree', '-r', '-z', input.head], env).stdout.toString(
    'utf8',
  );
  const files: Record<string, string> = {};
  const problems: string[] = [];
  for (const entry of listed.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const path = entry.slice(tab + 1);
    const [mode = '', type = '', oid = ''] = entry.slice(0, tab).split(' ');
    if (!isHashed(path)) continue;
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
      problems.push(`${path}: not a regular file (mode ${mode})`);
      continue;
    }
    const blob = safeGit(input.repo, ['cat-file', 'blob', oid], env).stdout;
    files[path] = createHash('sha256').update(blob).digest('hex');
  }
  return { files, problems };
}
