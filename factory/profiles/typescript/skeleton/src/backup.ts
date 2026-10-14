// The daily backup (FR-034): `npm run backup`, which factory deploy's systemd timer runs in the
// deploy sandbox, copies the database with SQLite's backup API to APP_BACKUPS/<yyyy-mm-dd>.sqlite,
// through a temporary file and a rename, and keeps the newest 14 such files; it touches no other
// name. Locally the folders are ./data and ./backups. Only `node:` imports, so it needs no build
// step to run from the source.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const KEEP = 14;
const DAILY = /^\d{4}-\d{2}-\d{2}\.sqlite$/;

/** Backs up `data`'s database into `backups`; the file's name, or undefined with no database. */
export async function backUp(data: string, backups: string, now = new Date()) {
  const source = join(data, 'app.sqlite');
  if (!existsSync(source)) return undefined;
  mkdirSync(backups, { recursive: true });
  const name = `${now.toISOString().slice(0, 10)}.sqlite`;
  const temporary = join(backups, `.${name}.tmp`);
  rmSync(temporary, { force: true });
  const db = new DatabaseSync(source);
  try {
    await backup(db, temporary);
  } finally {
    db.close();
  }
  renameSync(temporary, join(backups, name));
  const daily = readdirSync(backups)
    .filter((file) => DAILY.test(file))
    .sort()
    .reverse();
  for (const old of daily.slice(KEEP)) rmSync(join(backups, old));
  return name;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = await backUp(process.env.APP_DATA ?? 'data', process.env.APP_BACKUPS ?? 'backups');
  process.stdout.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      msg: name === undefined ? 'no database yet: nothing to back up' : 'backed up',
      ...(name === undefined ? {} : { file: name }),
    })}\n`,
  );
}
