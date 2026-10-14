// Old release folders go after a successful switch (T069, slice 23b-2b; Owner decisions
// 2026-10-14). Kept: the running release, the previous one and the newest other by deploy time,
// and whatever release either unit names, read from the units themselves, however old.
// `releases/` is listed and each entry checked with `lstat`: a link is removed as a link, never
// followed, and `rmSync` unlinks the links inside a folder it removes; names that are not
// `<sha>-<stamp>` stay. A folder that cannot be removed is a warning: the deploy itself has
// already succeeded.
import { lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { AppFolder } from './sandbox.js';
import { readUnit, RELEASE_NAME, unitName, unitRelease, type UnitPlace } from './service.js';

const KEPT = 3;

export interface Cleanup {
  removed: string[];
  /** One line per folder that could not be removed. */
  failed: string[];
}

export function cleanReleases(
  app: AppFolder,
  place: UnitPlace,
  repo: string,
  previous: string | undefined,
): Cleanup {
  const named = (['app', 'backup'] as const).map((run) => {
    const text = readUnit(place, unitName(repo, run));
    return text === undefined ? undefined : unitRelease(text, repo, run);
  });
  const kept = new Set([named[0], previous].filter((name) => name !== undefined));
  const releases = readdirSync(app.releases).filter((name) => RELEASE_NAME.test(name));
  // The running release, the previous one, then the newest others by deploy time, the part
  // after the commit; then whatever either unit names, however old.
  const byTime = [...releases].sort((a, b) => b.slice(41).localeCompare(a.slice(41)));
  for (const name of byTime) if (kept.size < KEPT) kept.add(name);
  for (const name of named) if (name !== undefined) kept.add(name);

  const result: Cleanup = { removed: [], failed: [] };
  for (const name of releases.filter((release) => !kept.has(release))) {
    const path = join(app.releases, name);
    try {
      if (lstatSync(path).isDirectory()) rmSync(path, { recursive: true });
      else unlinkSync(path);
      result.removed.push(name);
    } catch (err) {
      result.failed.push(`could not remove ${path}: ${(err as Error).message}`);
    }
  }
  return result;
}
