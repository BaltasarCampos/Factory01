// The station manifest (data-model.md § Station manifest, research R5): `specs/<feature>/
// .station.json`, committed by the dispatcher to the item branch before each session. Hooks read
// the session's item, station, branch and file list from it, never from the prompt; no role may
// write it. The Builder's manifest names the next open task of `tasks.md` and its files.
//
// The dispatcher's clone records the Build manifest commit it last pushed to a branch, which a
// session can neither see nor rewrite; it ticks a task only on history that holds it (T174).
import { EnvironmentError } from '../cli/env.js';
import { fileAt } from '../git/answers.js';
import type { RoleName, Station, StationManifest } from '../model/types.js';
import {
  commitAndPush,
  dispatcherMessage,
  featureOf,
  fetchBranch,
  git,
  type BranchContext,
  type ItemRef,
} from './branch.js';

const BUILD_SUBJECT = 'Dispatcher: station 4 (builder) manifest';

/** Where the dispatcher's clone records the Build manifest commit it last pushed to `branch`. */
export const issuedRef = (branch: string) => `refs/factory/build/${branch}`;

/** The manifest at `commit`: undefined when it is missing or not a JSON object; git failing throws. */
function manifestAt(ctx: BranchContext, commit: string, path: string) {
  const text = fileAt(ctx.projectDir, commit, path, ctx.env);
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The task the dispatcher's own manifest at `commit` names, undefined when it names none; one it
 * could not have written is an error.
 */
export function manifestTask(ctx: BranchContext, commit: string, path: string) {
  const manifest = manifestAt(ctx, commit, path);
  if (manifest !== undefined && manifest.task === undefined) return undefined;
  const task = manifest?.task;
  if (typeof task === 'string' && /^T\d+$/.test(task)) return task;
  throw new EnvironmentError(
    `${commit.slice(0, 12)}:${path} is not a Build manifest the dispatcher wrote`,
  );
}

/**
 * How many Build manifests on the branch since main name `task`: the times it was issued. A
 * session can only add commits, so a forged one, even one that cannot be read, only adds to it.
 */
export function buildIssues(
  ctx: BranchContext,
  tip: string,
  dir: string,
  task: string,
  mainRef = 'origin/main',
): number {
  const path = `${dir}/.station.json`;
  const log = git(ctx, ['log', '--first-parent', '--format=%H %s', `${mainRef}..${tip}`]);
  return log
    .split('\n')
    .filter((line) => line.endsWith(` ${BUILD_SUBJECT}`))
    .map((line) => manifestAt(ctx, line.slice(0, line.indexOf(' ')), path))
    .filter((manifest) => manifest === undefined || manifest.task === task).length;
}

/** Tick `task` in `tasks.md` on `head`, the branch's head, in the dispatcher's own commit. */
export function tickTask(ctx: BranchContext, item: ItemRef, task: string, head: string): void {
  const feature = featureOf(item);
  const path = `specs/${feature}/tasks.md`;
  const text = fileAt(ctx.projectDir, head, path, ctx.env) ?? '';
  const ticked = text.replace(new RegExp(`^(\\s*- \\[) (\\] ${task}\\b)`, 'm'), '$1X$2');
  if (ticked === text) return;
  const message = dispatcherMessage(`tick ${task}`, feature);
  commitAndPush(ctx, head, { [path]: ticked }, message, item.branch);
  fetchBranch(ctx, item.branch);
}

/** The first open task of `tasks.md` and the paths of its `· Files:` list. */
export function nextTask(tasks: string): { task: string; files: string[] } | undefined {
  const m = /^\s*- \[ \] (T\d+)\b(.*)$/m.exec(tasks);
  if (m === null) return undefined;
  const list = /·\s*Files:(.*)$/.exec(m[2] ?? '')?.[1] ?? '';
  const files = list
    .replace(/\([^)]*\)/g, '')
    .split(',')
    .map((f) => f.trim().replace(/^`|`$/g, ''))
    .filter((f) => f !== '' && !/\s/.test(f));
  return { task: m[1] ?? '', files };
}

/** The manifest on the branch tip, if the tip is the dispatcher's manifest commit. */
export function pendingManifest(ctx: BranchContext, tip: string): StationManifest | undefined {
  const message = git(ctx, ['log', '-1', '--format=%B', tip]);
  if (!/^Dispatcher: station \d/.test(message)) return undefined;
  const changed = git(ctx, ['diff-tree', '--no-commit-id', '--name-only', '-r', tip]);
  const [path] = changed.split('\n');
  if (path === undefined || !path.endsWith('/.station.json')) return undefined;
  return JSON.parse(git(ctx, ['show', `${tip}:${path}`])) as StationManifest;
}

/**
 * Whether Verify's Test session has ended since the last Build round (T181): on the branch's
 * first-parent history since main, its station 5 manifest is followed by a later commit, with no
 * Build manifest after it.
 */
export function testEnded(ctx: BranchContext, tip: string, mainRef = 'origin/main'): boolean {
  const log = git(ctx, ['log', '--first-parent', '--format=%s', `${mainRef}..${tip}`]);
  for (const [i, subject] of log.split('\n').entries()) {
    if (subject.startsWith('Dispatcher: station 4 (')) return false;
    if (subject === 'Dispatcher: station 5 (test) manifest') return i > 0;
  }
  return false;
}

export function writeStationManifest(
  ctx: BranchContext,
  item: ItemRef,
  session: { station: Station; role: RoleName },
): StationManifest {
  const feature = featureOf(item);
  const tip = fetchBranch(ctx, item.branch);
  if (tip === undefined) throw new Error(`${item.branch} does not exist on origin`);
  let task: ReturnType<typeof nextTask>;
  if (session.station === 4) {
    try {
      task = nextTask(git(ctx, ['show', `${tip}:specs/${feature}/tasks.md`]));
    } catch {
      task = undefined;
    }
  }
  const manifest: StationManifest = {
    item: item.issue,
    station: session.station,
    role: session.role,
    branch: item.branch,
    ...(task === undefined ? {} : task),
    issued_at: ctx.now().toISOString(),
  };
  const path = `specs/${feature}/.station.json`;
  const subject = `station ${String(session.station)} (${session.role}) manifest`;
  const files = { [path]: `${JSON.stringify(manifest, null, 2)}\n` };
  const sha = commitAndPush(ctx, tip, files, dispatcherMessage(subject, feature), item.branch);
  if (session.station === 4) git(ctx, ['update-ref', issuedRef(item.branch), sha]);
  fetchBranch(ctx, item.branch);
  return manifest;
}
