// The work-item branch (FR-016a, AC-066): created by the dispatcher, never by a session, under
// the name the Owner signed in the `approved` record's `branch` field, never re-derived from the
// issue title. Its first commit sets Spec Kit's feature folder (`.specify/feature.json`, research
// R9) and seeds `events.jsonl` with Intake's issue-comment events; one draft pull request per
// item is opened before Specify starts.
//
// Commits are built with git plumbing on a temporary index, so the dispatcher's working copy is
// never touched, and carry `Factory-Role: dispatcher`, which the trace accepts only for the files
// written here and by manifest.ts (src/events/trace.ts).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostedComment } from '../approvals/verify.js';
import { EnvironmentError } from '../cli/env.js';
import { redact } from '../events/redact.js';
import { validateEvent } from '../events/schema.js';
import { DISPATCHER } from '../events/trace.js';
import type { GhOptions } from '../github/gh.js';
import { createDraftPr, listPrs } from '../github/prs.js';
import { isSlug } from '../model/naming.js';
import type { Event } from '../model/types.js';
import { clean } from '../notify/summary.js';

export interface ItemRef {
  issue: number;
  /** The branch named by the verified `approved` record. */
  branch: string;
}

export interface BranchContext {
  /** A clone of the project with `origin`. */
  projectDir: string;
  now: () => Date;
  env?: NodeJS.ProcessEnv;
}

/** Caps on Intake's comment events (data-model.md § Event). */
export const MAX_BLOCKS = 4;
export const MAX_BLOCK_BYTES = 4096;
const BLOCK = /^```factory-event[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm;
const REDACTED = ['tool', 'input_summary', 'evidence'];

/** `<issue>-<slug>` of an item branch; refuses a branch that is not `claude/<issue>-<slug>`. */
export function featureOf(item: ItemRef): string {
  const m = /^claude\/(\d+)-(.+)$/.exec(item.branch);
  if (m?.[1] !== String(item.issue) || !isSlug(m[2] ?? ''))
    throw new EnvironmentError(`${item.branch} is not claude/${String(item.issue)}-<slug>`);
  return `${m[1]}-${m[2] ?? ''}`;
}

export function git(ctx: BranchContext, args: readonly string[], input?: string): string {
  const result = spawnSync('git', args, {
    cwd: ctx.projectDir,
    env: ctx.env ?? process.env,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });
  if (result.error !== undefined || result.status !== 0)
    throw new EnvironmentError(
      `git ${args[0] ?? ''} failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  return result.stdout.trim();
}

/** The branch's head on origin, fetched into `origin/<branch>`; undefined when it is absent. */
export function fetchBranch(ctx: BranchContext, branch: string): string | undefined {
  const line = git(ctx, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
  if (line === '') return undefined;
  git(ctx, ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  return line.split('\t')[0];
}

export const dispatcherMessage = (subject: string, feature: string) =>
  `Dispatcher: ${subject}\n\nFactory-Role: ${DISPATCHER}\nFactory-Item: ${feature}\n`;

/** Commit `files` on top of `parent` and push the commit to `branch` (create or fast-forward). */
export function commitAndPush(
  ctx: BranchContext,
  parent: string,
  files: Record<string, string>,
  message: string,
  branch: string,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-index-'));
  const who = { name: 'Factory dispatcher', email: 'dispatcher@factory.invalid' };
  const env = {
    ...(ctx.env ?? process.env),
    GIT_INDEX_FILE: join(dir, 'index'),
    ...{ GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email },
    ...{ GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email },
  };
  const at = { ...ctx, env };
  try {
    git(at, ['read-tree', parent]);
    for (const [path, text] of Object.entries(files)) {
      const blob = git(at, ['hash-object', '-w', '--stdin'], text);
      git(at, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
    }
    const tree = git(at, ['write-tree']);
    const sha = git(at, ['commit-tree', '--no-gpg-sign', tree, '-p', parent, '-m', message]);
    git(at, ['push', '-q', 'origin', `${sha}:refs/heads/${branch}`]);
    return sha;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Intake's events in one comment: valid blocks for this item, timed by GitHub, cleaned. */
function commentEvents(issue: number, comment: PostedComment): Event[] {
  // Signed records stay on the issue; the event log is telemetry (data-model § Approval record).
  if (comment.body.includes('```factory-record')) return [];
  const blocks = [...comment.body.matchAll(BLOCK)].map((m) => m[1] ?? '');
  if (blocks.length > MAX_BLOCKS) return [];
  return blocks.flatMap((text) => {
    if (Buffer.byteLength(text) > MAX_BLOCK_BYTES) return [];
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return [];
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
    const fields: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value))
      fields[key] =
        typeof v !== 'string' ? v : REDACTED.includes(key) ? redact(clean(v)) : clean(v);
    try {
      const event = validateEvent({ ...fields, ts: comment.createdAt });
      return event.item === issue && event.role === 'intake' ? [event] : [];
    } catch {
      return [];
    }
  });
}

/** The first lines of `events.jsonl`: each comment's events once, by comment ID. */
export function seedEvents(issue: number, comments: readonly PostedComment[]): string {
  const seen = new Set<string>();
  return comments
    .filter((c) => !seen.has(c.id) && seen.add(c.id))
    .flatMap((c) => commentEvents(issue, c))
    .map((e) => `${JSON.stringify(e)}\n`)
    .join('');
}

/**
 * Create the item branch from main with `.specify/feature.json` and the seeded event log.
 * False when the branch already exists: a later pass copies nothing.
 */
export function createItemBranch(
  ctx: BranchContext,
  item: ItemRef,
  comments: readonly PostedComment[],
  mainRef = 'origin/main',
): boolean {
  const feature = featureOf(item);
  if (fetchBranch(ctx, item.branch) !== undefined) return false;
  const files = {
    '.specify/feature.json': `${JSON.stringify({ feature_directory: `specs/${feature}` })}\n`,
    [`specs/${feature}/events.jsonl`]: seedEvents(item.issue, comments),
  };
  const main = git(ctx, ['rev-parse', '--verify', `${mainRef}^{commit}`]);
  commitAndPush(ctx, main, files, dispatcherMessage(`create ${item.branch}`, feature), item.branch);
  git(ctx, [
    'fetch',
    '-q',
    'origin',
    `+refs/heads/${item.branch}:refs/remotes/origin/${item.branch}`,
  ]);
  return true;
}

/** The item's one pull request: an existing one from its branch (in any state), or a new draft. */
export async function ensureDraftPr(
  repo: string,
  item: ItemRef & { title: string },
  options: GhOptions = {},
): Promise<number> {
  const [existing] = await listPrs(repo, { state: 'all', head: item.branch }, options);
  if (existing !== undefined) return existing.number;
  const n = String(item.issue);
  const body = `Work item #${n}. Opened by the dispatcher; the Owner merges it with \`factory merge\`.\n`;
  const title = `#${n} ${item.title}`;
  return createDraftPr(repo, { head: item.branch, base: 'main', title, body }, options);
}
