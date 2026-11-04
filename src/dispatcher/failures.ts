// The failure record of local sessions (T061): one file per item and station under
// `~/.factory/failures/<owner>/<repo>/`, which no session can reach, naming the dispatcher's own
// manifest commit, written before that commit is pushed, and the installed factory's hash. Whether
// a branch tip is the dispatcher's comes from this record alone, never from `.station.json`, its
// trailers or its time. Written to a temporary file and renamed into place, so a reader sees the
// old record or the new one, never half of one; a missing file is no record, and any other
// failure to read one stops the pass, naming the file, never counting as none.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EnvironmentError } from '../cli/env.js';
import type { Station } from '../model/types.js';
import { visible } from '../notify/summary.js';

export interface FailureRecord {
  /** The dispatcher's own manifest commit the record counts at. */
  head: string;
  /** The installed factory's hash when the manifest was issued (`factoryHash`). */
  factory: string;
  /** The failed attempts at `head`. */
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

export const failureFile = (home: string, repo: string, item: number, station: Station) =>
  join(home, '.factory', 'failures', ...repo.split('/'), `${String(item)}-${String(station)}.json`);

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
  const record = (value ?? {}) as Record<string, unknown>;
  const fields = ['head', 'factory', 'count', 'last'];
  const ok =
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(record).every((key) => fields.includes(key)) &&
    typeof record.head === 'string' &&
    /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(record.head) &&
    typeof record.factory === 'string' &&
    /^[0-9a-f]{64}$/.test(record.factory) &&
    Number.isSafeInteger(record.count) &&
    (record.count as number) >= 0 &&
    (record.last === undefined || typeof record.last === 'string');
  if (!ok) throw new EnvironmentError(`the failure record ${file} is malformed; ${OUT}`);
  return record as unknown as FailureRecord;
}

/** Writes the record by rename; one that cannot be written throws, naming the file. */
export function writeFailureRecord(file: string, record: FailureRecord): void {
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
    throw new EnvironmentError(`the failure record ${file} cannot be written: ${why(err)}`);
  }
}

/**
 * The dispatcher's manifest commit `head`, about to be pushed for a local session: a new record,
 * count 0, so a failure to write it stops the pass before the push.
 */
export function recordIssued(
  records: FailureRecords | undefined,
  at: { repo: string; item: number; station: Station },
  head: string,
): void {
  if (records === undefined)
    throw new EnvironmentError('no failure records are set up for local sessions');
  const file = failureFile(records.home, at.repo, at.item, at.station);
  writeFailureRecord(file, { head, factory: records.factory(), count: 0 });
}
