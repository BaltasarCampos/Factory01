// The station manifest (data-model.md § Station manifest, research R5): `specs/<feature>/
// .station.json`, committed by the dispatcher to the item branch before each session. Hooks read
// the session's item, station, branch and file list from it, never from the prompt; no role may
// write it. The Builder's manifest names the next open task of `tasks.md` and its files.
//
// The dispatcher's clone records the Build manifest commit it last pushed to a branch, which a
// session can neither see nor rewrite; it ticks a task only on history that holds it (T174).
import { EnvironmentError } from '../cli/env.js';
import { fileAt } from '../git/answers.js';
import { ROLES, type RoleName, type Station, type StationManifest } from '../model/types.js';
import { taskFiles } from '../stations/checks/plan.js';
import {
  commitAndPush,
  conflictedPaths,
  dispatcherMessage,
  featureOf,
  fetchBranch,
  git,
  gitAnswer,
  type BranchContext,
  type ItemRef,
} from './branch.js';

const BUILD_SUBJECT = 'Dispatcher: station 4 (builder) manifest';
/** The largest `.station.json` read at a tip: the dispatcher's are far smaller (T061). */
const MAX_MANIFEST = 64 * 1024;

/** Where the dispatcher's clone records the Build manifest commit it last pushed to `branch`. */
export const issuedRef = (branch: string) => `refs/factory/build/${branch}`;
/** Where it records the Test manifest commit it last pushed to `branch` (T181). */
export const testRef = (branch: string) => `refs/factory/test/${branch}`;

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
 * How many Build manifests on the branch since main name `task`, or no task when it is undefined,
 * as the conflict session's do: the times it was issued. A session can only add commits, so a
 * forged one, even one that cannot be read, only adds to it.
 */
export function buildIssues(
  ctx: BranchContext,
  tip: string,
  dir: string,
  task: string | undefined,
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
  // Plan's check refuses a path that is not plain, and the session's settings refuse it again.
  return { task: m[1] ?? '', files: taskFiles(m[2] ?? '') };
}

/**
 * The manifest on the branch tip, if the tip is the dispatcher's manifest commit by its subject;
 * `unreadable` when its `.station.json` is not `dir`'s, the item's feature folder, is not a plain
 * file, is over 64 KiB, is not a JSON object, or names no station from 1 to 7 or no role, which a
 * session may have forged (T061). At Build such a tip only issues the task again: it counts toward
 * Build's cap only with Build's exact subject, and the cap holds all the same, since each issue
 * pushes the dispatcher's own manifest. A git failure throws.
 */
export function pendingManifest(
  ctx: BranchContext,
  tip: string,
  dir: string | undefined,
): StationManifest | 'unreadable' | undefined {
  const subject = git(ctx, ['log', '-1', '--format=%s', tip]);
  if (!/^Dispatcher: station \d/.test(subject)) return undefined;
  const changed = git(ctx, ['diff-tree', '--no-commit-id', '--name-only', '-z', '-r', tip]);
  const [path] = changed.split('\0');
  if (path === undefined || !path.endsWith('/.station.json')) return undefined;
  // A session wrote that path: only the item's own is read, and as a literal path, since pathspec
  // magic such as `:(glob)` or `:/` could fail every pass or reach another file.
  if (dir === undefined || path !== `${dir}/.station.json`) return 'unreadable';
  // Its mode and size first: anything but a plain file within the limit is not the dispatcher's,
  // and reading it could stop every pass. The blob read is the one whose size was checked.
  const listed = git(ctx, ['--literal-pathspecs', 'ls-tree', '-l', '-z', tip, '--', path]);
  const entry = /^100644 blob ([0-9a-f]+) +(\d+)\t/.exec(listed);
  if (entry?.[1] === undefined || Number(entry[2]) > MAX_MANIFEST) return 'unreadable';
  const text = git(ctx, ['cat-file', 'blob', entry[1]]);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'unreadable';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'unreadable';
  const { station, role } = value as Record<string, unknown>;
  const named =
    Number.isInteger(station) &&
    (station as number) >= 1 &&
    (station as number) <= 7 &&
    (ROLES as readonly unknown[]).includes(role);
  return named ? (value as StationManifest) : 'unreadable';
}

/** The station of the manifest at the tip; undefined for none, or for one that cannot be read. */
export const pendingStation = (ctx: BranchContext, tip: string, dir: string | undefined) => {
  const manifest = pendingManifest(ctx, tip, dir);
  return manifest === 'unreadable' ? undefined : manifest?.station;
};

/**
 * Whether Verify's Test session has ended since the last Build round (T181), from the dispatcher's
 * own records alone, never a commit subject a session could write: the Test manifest it last
 * pushed is in `tip`'s history and is not `tip`, and the Build manifest it last pushed, if any, is
 * an ancestor of it. A missing record reads as not ended, so Test runs once more; only git's exit 1
 * is an answer, and any other failure stops the pass.
 */
export function testEnded(ctx: BranchContext, branch: string, tip: string): boolean {
  const issued = (ref: string) =>
    gitAnswer(ctx, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  const before = (a: string, b: string) =>
    gitAnswer(ctx, ['merge-base', '--is-ancestor', a, b]) !== undefined;
  const test = issued(testRef(branch));
  if (test === undefined || test === tip || !before(test, tip)) return false;
  const build = issued(issuedRef(branch));
  return build === undefined || before(build, test);
}

/**
 * `issued` hears the manifest commit, and the tip it is made on, before it is pushed: local mode's
 * failure record (T061).
 */
export function writeStationManifest(
  ctx: BranchContext,
  item: ItemRef,
  session: { station: Station; role: RoleName; failure?: string },
  mainRef = 'origin/main',
  issued?: (sha: string, parent: string) => void,
): StationManifest {
  const feature = featureOf(item);
  const tip = fetchBranch(ctx, item.branch);
  if (tip === undefined) throw new Error(`${item.branch} does not exist on origin`);
  let task: ReturnType<typeof nextTask>;
  let conflicts: string[] | undefined;
  if (session.station === 4) {
    // A git failure throws: only a missing tasks.md reads as no open task.
    const tasks = fileAt(ctx.projectDir, tip, `specs/${feature}/tasks.md`, ctx.env);
    task = tasks === undefined ? undefined : nextTask(tasks);
    // Every task ticked: the conflict session, with the files git finds conflicted when merging
    // main in, never the ones Integrate's report lists (T174).
    if (task === undefined) conflicts = conflictedPaths(ctx, tip, mainRef);
  }
  const manifest: StationManifest = {
    item: item.issue,
    station: session.station,
    role: session.role,
    branch: item.branch,
    ...(task === undefined ? {} : task),
    ...(conflicts === undefined ? {} : { files: conflicts }),
    ...(session.failure === undefined ? {} : { failure: session.failure }),
    issued_at: ctx.now().toISOString(),
  };
  const path = `specs/${feature}/.station.json`;
  const subject = `station ${String(session.station)} (${session.role}) manifest`;
  const files = { [path]: `${JSON.stringify(manifest, null, 2)}\n` };
  const message = dispatcherMessage(subject, feature);
  const sha = commitAndPush(ctx, tip, files, message, item.branch, (made) => {
    issued?.(made, tip);
  });
  // Recorded only once the push succeeded, so a record never names a commit the branch lacks.
  if (session.station === 4) git(ctx, ['update-ref', issuedRef(item.branch), sha]);
  if (session.station === 5 && session.role === 'test')
    git(ctx, ['update-ref', testRef(item.branch), sha]);
  fetchBranch(ctx, item.branch);
  return manifest;
}
