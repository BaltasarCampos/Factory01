// Release folders (T069; Owner decisions 2026-10-13): every deploy exports main's verified commit
// into a new `releases/<sha>-<deploy time>` folder, which `mkdir` refuses if it is already there,
// so a redeploy of the same commit never writes into, or through, an old release. The app folder's
// parts are made here, and each must be a real folder, never a link, since a run with the app
// folder writable could otherwise point one somewhere else.
import { lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RefusedError } from '../cli/env.js';
import { exportTree } from '../git/export.js';
import type { AppFolder } from './sandbox.js';

/** `20261013T153000Z` for 2026-10-13 15:30:00 UTC. */
export const stamp = (now: Date) =>
  now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

/** Exports `commit` from `repo` into a new release folder; returns its path. */
export function newRelease(
  app: AppFolder,
  repo: string,
  commit: string,
  now: Date,
  env: NodeJS.ProcessEnv,
): string {
  mkdirSync(app.root, { recursive: true });
  for (const folder of [app.releases, app.data, app.backups]) {
    const stat = lstatSync(folder, { throwIfNoEntry: false });
    if (stat === undefined) mkdirSync(folder);
    else if (!stat.isDirectory())
      throw new RefusedError(`${folder} is not a folder: nothing was deployed`);
  }
  const release = join(app.releases, `${commit}-${stamp(now)}`);
  exportTree(repo, commit, release, env);
  return release;
}
