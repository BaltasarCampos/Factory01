// Product backups (T129, FR-034; slice 23b-2b): the skeleton's `npm run backup` copies the
// database with SQLite's backup API to APP_BACKUPS/<yyyy-mm-dd>.sqlite and keeps the newest 14,
// touching no other name. Run here with Node from the source, as its `node:`-only imports allow;
// the daily timer that runs it in the deploy sandbox is checked with `factory deploy`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../helpers/keys.js';

const SCRIPT = fileURLToPath(
  new URL('../../factory/profiles/typescript/skeleton/src/backup.ts', import.meta.url),
);

function backUp(data: string, backups: string) {
  const run = spawnSync(process.execPath, ['--no-warnings', SCRIPT], {
    env: { PATH: process.env.PATH, APP_DATA: data, APP_BACKUPS: backups },
    encoding: 'utf8',
  });
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout) as { msg: string; file?: string };
}

describe('the skeleton’s daily backup (T129, FR-034)', () => {
  it('copies the database to <yyyy-mm-dd>.sqlite, keeps the newest 14 and no other name is touched', () => {
    const [data, backups] = [join(tempDir(), 'data'), join(tempDir(), 'backups')];
    mkdirSync(data);
    mkdirSync(backups);
    const db = new DatabaseSync(join(data, 'app.sqlite'));
    db.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('kept')");
    db.close();
    const old = Array.from(
      { length: 15 },
      (_, i) => `2020-01-${String(i + 1).padStart(2, '0')}.sqlite`,
    );
    for (const name of [...old, 'notes.txt', '2020-01-01.sqlite.bak'])
      writeFileSync(join(backups, name), 'old');

    const out = backUp(data, backups);

    const today = `${new Date().toISOString().slice(0, 10)}.sqlite`;
    expect(out).toMatchObject({ msg: 'backed up', file: today });
    const copy = new DatabaseSync(join(backups, today), { readOnly: true });
    expect(copy.prepare('SELECT body FROM notes').all()).toEqual([{ body: 'kept' }]);
    copy.close();
    expect(readdirSync(backups).sort()).toEqual(
      [...old.slice(2), today, 'notes.txt', '2020-01-01.sqlite.bak'].sort(),
    );
  });

  it('with no database yet, says so and writes nothing', () => {
    const [data, backups] = [join(tempDir(), 'data'), join(tempDir(), 'backups')];

    expect(backUp(data, backups).msg).toBe('no database yet: nothing to back up');
    expect(existsSync(backups)).toBe(false);
  });
});
