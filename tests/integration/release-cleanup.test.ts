// Old releases go after a successful switch (T069, slice 23b-2b; Owner decisions 2026-10-14):
// kept are the release each unit names, read from the units, the previous one, and the newest
// others until three are kept; entries are checked with lstat and a link is never followed.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanReleases } from '../../src/deploy/cleanup.js';
import { appFolder } from '../../src/deploy/sandbox.js';
import { appUnit, backupUnit, unitName } from '../../src/deploy/service.js';
import { tempDir } from '../helpers/keys.js';

const REPO = 'owner/project';
const release = (day: number) =>
  `${String(day).repeat(40).slice(0, 40)}-202610${String(day).padStart(2, '0')}T000000Z`;

function setup(days: number[]) {
  const home = realpathSync(tempDir());
  const app = appFolder(home, REPO);
  for (const day of days) {
    mkdirSync(join(app.releases, release(day), 'dist'), { recursive: true });
    writeFileSync(join(app.releases, release(day), 'dist', 'out.txt'), 'built');
  }
  const place = { dir: join(home, 'units'), runtime: false };
  mkdirSync(place.dir);
  const units = (appDay: number, backupDay: number) => {
    const spec = (day: number) => ({
      ...{ repo: REPO, release: release(day), port: 8080, home },
      ...{ factory: '/f', program: ['/usr/bin/node', '/f/main.js'] },
    });
    writeFileSync(join(place.dir, unitName(REPO)), appUnit(spec(appDay)));
    writeFileSync(join(place.dir, unitName(REPO, 'backup')), backupUnit(spec(backupDay)));
  };
  const left = () => readdirSync(app.releases).sort();
  return { app, place, units, left };
}

describe('release cleanup (T069)', () => {
  it('keeps the running release, the previous one and one more', () => {
    const s = setup([1, 2, 3, 4, 5, 6]);
    s.units(6, 6);

    const r = cleanReleases(s.app, s.place, REPO, release(3));

    expect(s.left()).toEqual([release(3), release(5), release(6)]);
    expect(r).toEqual({ removed: [release(1), release(2), release(4)], failed: [] });
  });

  it('never removes a release either unit names, even one older than the three kept', () => {
    const s = setup([1, 2, 3, 4, 5, 6]);
    s.units(6, 1);

    cleanReleases(s.app, s.place, REPO, release(2));

    expect(s.left()).toEqual([release(1), release(2), release(5), release(6)]);
  });

  it('removes a planted link as a link, follows none inside a folder, and leaves other names alone', () => {
    const s = setup([1, 2, 3, 4]);
    s.units(4, 4);
    const outside = realpathSync(tempDir());
    writeFileSync(join(outside, 'precious'), 'keep');
    symlinkSync(outside, join(s.app.releases, release(1), 'src'));
    symlinkSync(outside, join(s.app.releases, release(0)));
    mkdirSync(join(s.app.releases, 'not-a-release'));

    cleanReleases(s.app, s.place, REPO, release(3));

    expect(s.left()).toEqual([release(2), release(3), release(4), 'not-a-release']);
    expect(readdirSync(outside)).toEqual(['precious']);
    expect(existsSync(join(outside, 'precious'))).toBe(true);
  });
});
