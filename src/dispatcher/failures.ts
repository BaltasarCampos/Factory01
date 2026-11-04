// The failure record of local sessions (T061): one file per item and station under
// `~/.factory/failures/<owner>/<repo>/`, which no session can reach, naming the dispatcher's own
// manifest commit, written before that commit is pushed, and the installed factory's hash. Whether
// a branch tip is the dispatcher's comes from this record alone, never from `.station.json`, its
// trailers or its time. Written to a temporary file and renamed into place, so a reader sees the
// old record or the new one, never half of one; a missing file is no record, and any other
// failure to read one stops the pass, naming the file, never counting as none.
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { EnvironmentError } from '../cli/env.js';
import type { Station } from '../model/types.js';
import { visible } from '../notify/summary.js';

export interface FailureRecord {
  /** The dispatcher's own manifest commit the record counts at. */
  head: string;
  /** The installed factory's hash when the manifest was issued (`factoryHash`). */
  factory: string;
  /** The attempts at `head`, each counted when it starts. */
  count: number;
  /** The last attempt's failure. */
  last?: string;
}

/** Where local sessions' failure records live, and the installed factory's hash. */
export interface FailureRecords {
  home: string;
  factory: () => string;
}

const why = (err: unknown) => visible(err instanceof Error ? err.message : String(err));
const OUT = 'delete it, by its path, to start its count again';

/**
 * The record's file for `repo`, exactly `owner/name` in GitHub's name characters, neither part
 * `.` or `..`, both lower-cased, since GitHub names ignore case.
 */
export function failureFile(home: string, repo: string, item: number, station: Station) {
  const parts = repo.toLowerCase().split('/');
  const [owner = '', name = ''] = parts;
  if (parts.length !== 2 || !/^[a-z0-9-]+$/.test(owner) || !/^(?!\.\.?$)[a-z0-9._-]+$/.test(name))
    throw new EnvironmentError(
      `${visible(repo)} is not a GitHub owner/name: it has no failure record`,
    );
  return join(home, '.factory', 'failures', owner, name, `${String(item)}-${String(station)}.json`);
}

/** Whether `value` is a record: what is read, and what may be written. */
function isRecord(value: unknown): value is FailureRecord {
  const record = (value ?? {}) as Record<string, unknown>;
  const fields = ['head', 'factory', 'count', 'last'];
  return (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(record).every((key) => fields.includes(key)) &&
    typeof record.head === 'string' &&
    /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(record.head) &&
    typeof record.factory === 'string' &&
    /^[0-9a-f]{64}$/.test(record.factory) &&
    Number.isSafeInteger(record.count) &&
    (record.count as number) >= 0 &&
    (record.last === undefined || typeof record.last === 'string')
  );
}

/** The record at `file`; undefined when there is none. */
export function readFailureRecord(file: string): FailureRecord | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new EnvironmentError(`the failure record ${file} cannot be read: ${why(err)}; ${OUT}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new EnvironmentError(`the failure record ${file} is not JSON: ${why(err)}; ${OUT}`);
  }
  if (!isRecord(value))
    throw new EnvironmentError(`the failure record ${file} is malformed; ${OUT}`);
  return value;
}

/**
 * Writes the record by rename; one the reader would refuse, or one that cannot be written, throws,
 * naming the file, so a bad record never stops every later pass.
 */
export function writeFailureRecord(file: string, record: FailureRecord): void {
  if (!isRecord(record))
    throw new EnvironmentError(
      `the failure record ${file} is not written: ${visible(JSON.stringify(record))} is malformed`,
    );
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } catch (err) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Its folder cannot be reached either: there is no temporary file to remove.
    }
    throw new EnvironmentError(
      `the failure record ${file} cannot be written: ${why(err)}; check that ${dirname(file)} can be written and its disk has free space, then run the factory again`,
    );
  }
}

/**
 * The dispatcher's manifest commit `head` on `parent`, about to be pushed for a local session: a
 * new record, count 0, so a failure to write it stops the pass before the push. The record there
 * is read first, and one that names `parent` is the factory's own spent manifest, which a new one
 * never stacks on, since that would wipe its count.
 */
export function recordIssued(
  records: FailureRecords | undefined,
  at: { repo: string; item: number; station: Station },
  head: string,
  parent: string,
): void {
  if (records === undefined)
    throw new EnvironmentError('no failure records are set up for local sessions');
  const file = failureFile(records.home, at.repo, at.item, at.station);
  if (readFailureRecord(file)?.head === parent)
    throw new EnvironmentError(
      `no manifest is pushed on ${parent.slice(0, 12)}: the failure record ${file} names it as the dispatcher's own manifest, which a new one never stacks on; ${OUT}`,
    );
  writeFailureRecord(file, { head, factory: records.factory(), count: 0 });
}

/**
 * A SHA-256 over every file of `folders` under `root`, each by its path from `root` and its
 * contents, in a fixed sorted order, so a renamed or moved file changes it too; a symlink is
 * hashed as its link, never followed. Anything else, or anything that cannot be read, throws,
 * naming it: never an empty or partial hash.
 */
export function factoryHash(root: string, folders: readonly string[]): string {
  const hash = createHash('sha256');
  const named = <T>(path: string, read: () => T): T => {
    try {
      return read();
    } catch (err) {
      throw new EnvironmentError(
        `the installed factory cannot be hashed: ${join(root, path)}: ${why(err)}; reinstall the pinned release, or remove that file if it is not the factory's`,
      );
    }
  };
  const add = (path: string): void => {
    const entries = named(path, () => readdirSync(join(root, path), { withFileTypes: true }));
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const at = `${path}/${entry.name}`;
      if (entry.isDirectory()) add(at);
      else if (entry.isSymbolicLink()) {
        const link = named(at, () => readlinkSync(join(root, at)));
        hash.update(`${JSON.stringify(['link', at, link])}\n`);
      } else if (entry.isFile()) {
        const bytes = named(at, () => readFileSync(join(root, at)));
        hash.update(`${JSON.stringify(['file', at, bytes.length])}\n`).update(bytes);
      } else
        named(at, () => {
          throw new Error('it is not a regular file, a folder or a symlink');
        });
    }
  };
  for (const folder of folders) add(folder);
  return hash.digest('hex');
}

/**
 * The factory's hash under `root`, taken now, once: what a long run records is the release it
 * started with. A failure to take it is raised only when the hash is needed.
 */
export function hashOnce(root: string, folders: readonly string[]): () => string {
  try {
    const hash = factoryHash(root, folders);
    return () => hash;
  } catch (err) {
    return () => {
      throw err;
    };
  }
}
