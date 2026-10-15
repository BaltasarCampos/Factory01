// The laptop's record of successful deploys (T069, slice 23c-1a; Owner decisions 2026-10-14):
// `~/.factory/verified/<owner>/<repo>.deploys.log`, beside the signed-history ledger and outside
// the app folder, so nothing the app runs can shorten the next deploy's re-check. One JSON line
// per deploy, with its `deployed` and `deploy-healthy` records' comment ids, appended only once
// the second is posted (slice 23d), never through a link, mode 600. Its last
// line names the commit deployed last; no file means nothing was deployed yet.
import { closeSync, constants, lstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { RefusedError } from '../cli/env.js';
import { realFolder } from '../fs/safe-files.js';
import { ledgerPath } from '../git/history.js';

export interface DeployEntry {
  /** When the switch passed. */
  at: string;
  /** Main's verified head, deployed. */
  main: string;
  /** The release folder's name. */
  release: string;
  /** The comment id of the signed `deployed` record on the inbox issue (slice 23c-1b). */
  record?: string;
  /** The comment id of the signed `deploy-healthy` record on the inbox issue (slice 23d). */
  healthy?: string;
}

export const deploysLogPath = (home: string, repo: string) =>
  `${ledgerPath(home, repo)}.deploys.log`;

const SHA = /^[0-9a-f]{40}$/;

/** The last deploy the log records; undefined when there is no log yet. */
export function lastDeploy(path: string): DeployEntry | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (!stat.isFile()) throw new RefusedError(`${path} is not a regular file; nothing was deployed`);
  let last: DeployEntry | undefined;
  for (const [i, line] of readFileSync(path, 'utf8').split('\n').entries()) {
    if (line === '') continue;
    let entry: Partial<DeployEntry> = {};
    try {
      entry = JSON.parse(line) as Partial<DeployEntry>;
    } catch {
      // Named below.
    }
    if (typeof entry.main !== 'string' || !SHA.test(entry.main))
      throw new RefusedError(
        `${path}: line ${String(i + 1)} is not a deploy this factory wrote; nothing was deployed`,
      );
    last = entry as DeployEntry;
  }
  return last;
}

/** Appends `entry`, creating the log in a real folder, never through a link. */
export function appendDeploy(path: string, entry: DeployEntry): void {
  realFolder(dirname(path));
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${JSON.stringify(entry)}\n`);
  } finally {
    closeSync(fd);
  }
}
