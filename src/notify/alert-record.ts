// The laptop's record of the alerts the factory raised (T030): one file per alert under
// `~/.factory/alerts/<owner>/<repo>/`, which no session writes, named by a hash of its kind,
// urgency and text, so no text becomes a path. An alert is raised once by this record, never by
// the inbox, where anyone's comment can pass for the factory's. Only a missing file means it was
// never raised: any other failure to read one stops, naming it, and never reads as either.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
}

/** What names an alert: two alike in all three are one. */
export type AlertKey = Pick<AlertRecord, 'urgency' | 'kind' | 'text'>;

const FIELDS = ['urgency', 'kind', 'text', 'id'];
const OUT = 'delete it, by its path, and its alert is posted again';
const why = (err: unknown) => visible(err instanceof Error ? err.message : String(err));

const nameOf = ({ kind, urgency, text }: AlertKey) =>
  `${createHash('sha256')
    .update(JSON.stringify([kind, urgency, text]))
    .digest('hex')}.json`;

export function alertFile(home: string, repo: string, key: AlertKey): string {
  const [owner, name] = repoParts(repo);
  return join(home, '.factory', 'alerts', owner, name, nameOf(key));
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

/** Writes the record of a posted alert, whole or not at all. */
export function writeAlertRecord(file: string, record: AlertRecord): void {
  try {
    replaceFile(file, `${JSON.stringify(record)}\n`);
  } catch (err) {
    throw new EnvironmentError(
      `the alert record ${file} cannot be written: ${why(err)}; its alert is on the inbox and is posted again until it can: check that the folder can be written and its disk has free space`,
    );
  }
}
