// The session's record (T086): what the launcher issued a session, written before launch under
// `~/.factory/sessions/<session_id>/session.json`, where no session can read or write (slice 28-4).
// The hooks take the role, item, station, feature folder, task files and clone from it, never from
// the clone's `.station.json`, which a session's shell can change, nor from the hook input's
// `agent_type`. A missing or malformed record is an error, and the caller blocks.
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ROLES, type RoleName, type Station } from '../model/types.js';
import { HookError } from './log.js';

export interface SessionRecord {
  role: RoleName;
  /** Issue number; 0 for project-level work. */
  item: number;
  station: Station;
  /** The item's feature folder, `specs/<issue>-<slug>`; empty for a role on a fixed branch. */
  feature: string;
  /** The task's files, or a conflict session's conflicted files. */
  files: string[];
  /** The session's clone, by its real path. */
  clone: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The folder of the session's own files under `~/.factory/`. */
export const sessionFolder = (home: string, session: string) =>
  join(home, '.factory', 'sessions', session);

export function readSessionRecord(home: string, session: unknown): SessionRecord {
  if (typeof session !== 'string' || !UUID.test(session))
    throw new HookError(`hook input session_id ${JSON.stringify(session)} is not a session id`);
  const path = join(sessionFolder(home, session), 'session.json');
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new HookError(`the session's record ${path} could not be read: ${String(error)}`);
  }
  const r = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const int = (v: unknown, max = Number.MAX_SAFE_INTEGER) =>
    Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
  const checks: [string, boolean][] = [
    ['role', (ROLES as readonly unknown[]).includes(r.role)],
    ['item', int(r.item)],
    ['station', int(r.station, 8)],
    ['feature', typeof r.feature === 'string'],
    ['files', Array.isArray(r.files) && r.files.every((f) => typeof f === 'string')],
    ['clone', typeof r.clone === 'string' && isAbsolute(r.clone)],
  ];
  const problem = checks.find(([, ok]) => !ok)?.[0];
  if (problem !== undefined) throw new HookError(`the session's record ${path}: bad ${problem}`);
  return r as unknown as SessionRecord;
}
