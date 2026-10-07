// The station manifest (data-model.md § Station manifest, research R5): `specs/<feature>/
// .station.json`, committed by the dispatcher to the item branch before each session. Hooks read
// the session's item, station, branch and file list from it, never from the prompt; no role may
// write it. The Builder's manifest names the next open task of `tasks.md` and its files.
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
  commitAndPush(ctx, tip, files, dispatcherMessage(subject, feature), item.branch);
  fetchBranch(ctx, item.branch);
  return manifest;
}
