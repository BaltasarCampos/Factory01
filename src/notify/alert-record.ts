// The laptop's record of the alerts the factory raised (T030): one file per alert under
// `~/.factory/alerts/<owner>/<repo>/`, which no session writes, named by a hash of its kind,
// urgency and text, so no text becomes a path. An alert is raised once by this record, never by
// the inbox, where anyone's comment can pass for the factory's. Only a missing file means it was
// never raised: any other failure to read one stops, naming it, and never reads as either. An
// urgent alert's record also says while its email is still to be sent, and one file beside the
// records says that emails are failing, so that spell is alerted once.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EnvironmentError } from '../cli/env.js';
import { replaceFile, repoParts } from '../dispatcher/failures.js';
import type { Alert } from '../model/types.js';
import { visible } from './summary.js';

export interface AlertRecord {
  urgency: Alert['urgency'];
  kind: string;
  text: string;
  /** The id in the posted comment's marker. */
  id: string;
  /** An urgent alert's email whose trigger has not yet succeeded. */
  email?: 'pending';
}

/** What names an alert: two alike in all three are one. */
export type AlertKey = Pick<AlertRecord, 'urgency' | 'kind' | 'text'>;

const FIELDS = ['urgency', 'kind', 'text', 'id', 'email'];
const OUT = 'delete it, by its path, and its alert is posted again';
const RECORD_RE = /^[0-9a-f]{64}\.json$/;
const ROOM = 'check that the folder can be written and its disk has free space';
const why = (err: unknown) => visible(err instanceof Error ? err.message : String(err));

const nameOf = ({ kind, urgency, text }: AlertKey) =>
  `${createHash('sha256')
    .update(JSON.stringify([kind, urgency, text]))
    .digest('hex')}.json`;

function folderOf(home: string, repo: string): string {
  const [owner, name] = repoParts(repo);
  return join(home, '.factory', 'alerts', owner, name);
}

export function alertFile(home: string, repo: string, key: AlertKey): string {
  return join(folderOf(home, repo), nameOf(key));
}

/** Whether `value` is the record `file` is named for. */
function isRecord(value: unknown, file: string): value is AlertRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => FIELDS.includes(key)) &&
    (record.urgency === 'urgent' || record.urgency === 'info') &&
    typeof record.kind === 'string' &&
    typeof record.text === 'string' &&
    typeof record.id === 'string' &&
    /^[0-9A-HJKMNP-TV-Z]{26}$/.test(record.id) &&
    (record.email === undefined || (record.email === 'pending' && record.urgency === 'urgent')) &&
    nameOf(record as unknown as AlertKey) === basename(file)
  );
}

/** The record at `file`; undefined when there is none. */
export function readAlertRecord(file: string): AlertRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new EnvironmentError(`the alert record ${file} cannot be read: ${why(err)}; ${OUT}`);
  }
  if (!isRecord(value, file))
    throw new EnvironmentError(`the alert record ${file} is malformed; ${OUT}`);
  return value;
}

/**
 * Writes the record of a posted alert, whole or not at all; `until` says what repeats while it
 * cannot be written.
 */
export function writeAlertRecord(
  file: string,
  record: AlertRecord,
  until = 'its alert is on the inbox and is posted again until it can',
): void {
  try {
    replaceFile(file, `${JSON.stringify(record)}\n`);
  } catch (err) {
    throw new EnvironmentError(
      `the alert record ${file} cannot be written: ${why(err)}; ${until}: ${ROOM}`,
    );
  }
}

/** The records of `repo` whose email is still to be sent, oldest first. */
export function pendingEmails(home: string, repo: string) {
  const folder = folderOf(home, repo);
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new EnvironmentError(
      `the alert records in ${folder} cannot be listed: ${why(err)}; make it a folder you can read`,
    );
  }
  // Anything else there, the spell's file or a write cut short, is no record.
  return names
    .filter((name) => RECORD_RE.test(name))
    .flatMap((name) => {
      const file = join(folder, name);
      const record = readAlertRecord(file);
      return record?.email === 'pending' ? [{ file, record }] : [];
    })
    .sort((a, b) => a.record.id.localeCompare(b.record.id));
}

/** The file that stands while emails are failing. */
export const spellFile = (home: string, repo: string) =>
  join(folderOf(home, repo), 'email-failing');

/** Whether a failing spell is open: only a missing file means none. */
export function spellOpen(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new EnvironmentError(`${file} cannot be read: ${why(err)}; delete it, by its path`);
  }
}

/** Opens a spell once its alert, of this id, is posted. */
export function openSpell(file: string, id: string): void {
  try {
    replaceFile(file, `${id}\n`);
  } catch (err) {
    throw new EnvironmentError(
      `${file} cannot be written: ${why(err)}; the failing emails are alerted again until it can: ${ROOM}`,
    );
  }
}

export function endSpell(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch (err) {
    throw new EnvironmentError(`${file} cannot be removed: ${why(err)}; delete it, by its path`);
  }
}
