// Intake's per-item file (design, Branches, "Before the branch exists"; T086, built in slice 28-5c-4c):
// each time an Intake session ends, failed ones included, the dispatcher appends that session's
// log to `~/.factory/items/<owner>/<repo>/<issue>/events.jsonl` on the laptop, after one factory
// line naming the session, never overwriting, the attempts in order. Each line is checked as an
// event of that session, and one that is not is replaced by a factory line saying which and why;
// a log missing or unreadable gets one such line. A copied line names its own session alone, so
// no session can write a line that passes for another session's marker. Slice 28-5c-4d reads the
// file: the sessions its markers name, for recovery, and its lines, for the item branch's seed.
// The file is telemetry, never a decision; only its read or write failing stops the pass.
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  fsyncSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { EnvironmentError } from '../cli/env.js';
import { makeEvent } from '../events/append.js';
import { MAX_APPEND, MAX_LOG } from '../hooks/events-commit.js';
import { readSessionRecord, recordEvent, sessionEvents } from '../hooks/session.js';
import { sessionLines } from '../hooks/session-log.js';
import { visible } from '../notify/summary.js';
import { validateEvent } from '../events/schema.js';
import { failureFile, readFailureRecord, repoParts } from './failures.js';
import { present, sessionRunning } from './launcher/local.js';

/** The item's file of Intake's events, kept until its branch carries them (built in 28-5c-4c, read in 28-5c-4d). */
export function intakeEventsFile(home: string, repo: string, issue: number): string {
  const [owner, name] = repoParts(repo);
  return join(home, '.factory', 'items', owner, name, String(issue), 'events.jsonl');
}

/** The marker's text: the factory line that opens a session's lines in the file. */
export const intakeMark = (session: string) =>
  `Intake session ${session} ended; its log's lines follow`;

const failed = (what: string, file: string, err: unknown) =>
  new EnvironmentError(
    `${what} Intake's events file ${file}: ${visible(err instanceof Error ? err.message : String(err))}`,
  );

/** The factory's line that says the file is full: written once, and then nothing is appended. */
export const INTAKE_FULL = `Intake's events file is full, past ${String(MAX_LOG / (1024 * 1024))} MiB; the rest of this session's lines and later sessions' lines are left out`;

interface Scanned {
  text: string;
  sessions: Set<string>;
  /** Whether the factory's full line is in the file. */
  full: boolean;
  size: number;
}

/**
 * The file's sessions, whose marker the file holds, and whether it is full; none and not full
 * when it is missing. A marker is the factory's `alert` line by the `Dispatcher` whose text names
 * its own `session` field. Any other read failure throws, never reading as none.
 */
function scan(file: string): Scanned {
  let text: string;
  let size: number;
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      size = stat.size;
      if (!stat.isFile()) throw new Error('it is not a regular file');
      // Bounded as the work's event log is: past it nothing is read. The factory's own appends
      // stop short of it, so this catches a file the factory did not write.
      if (size > MAX_LOG)
        throw new Error(
          `it is ${String(size)} bytes, past the ${String(MAX_LOG / (1024 * 1024))} MiB the factory reads; close the item and file it again, or delete the file`,
        );
      text = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { text: '', sessions: new Set(), full: false, size: 0 };
    throw failed('could not read', file, err);
  }
  const found = new Set<string>();
  let full = false;
  for (const line of text.split('\n')) {
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof e !== 'object' || e === null) continue;
    const { kind, tool, session, input_summary: summary } = e as Record<string, unknown>;
    if (kind !== 'alert' || tool !== 'Dispatcher') continue;
    if (summary === INTAKE_FULL) full = true;
    else if (typeof session === 'string' && summary === intakeMark(session)) found.add(session);
  }
  return { text, sessions: found, full, size };
}

export const intakeSessions = (file: string): Set<string> => scan(file).sessions;

/**
 * Appends Intake session `session`'s log to its item's file, once: a session the file already
 * marks adds nothing. The file is opened without following a link and only appended to, its
 * folders 0700 and itself 0600; a read or write failure throws.
 */
export function appendIntakeSession(
  home: string,
  repo: string,
  issue: number,
  session: string,
  now: () => Date,
): void {
  const file = intakeEventsFile(home, repo, issue);
  const state = scan(file);
  // A full file takes nothing more: the session's lines are only in its own log.
  if (state.sessions.has(session) || state.full) return;
  const record = readSessionRecord(home, session);
  if (record.role !== 'intake' || record.item !== issue)
    throw new EnvironmentError(
      `session ${session} is not an Intake session of #${String(issue)}: the factory's own error`,
    );
  const note = (summary: string) =>
    Buffer.from(
      JSON.stringify(
        makeEvent(
          recordEvent(record, session, {
            kind: 'alert',
            tool: 'Dispatcher',
            input_summary: summary,
          }),
          now,
        ),
      ),
    );
  const { lines, left } = sessionLines(sessionEvents(home, session), session, MAX_APPEND, note);
  if (left !== undefined)
    lines.push(
      note(
        `the session's log from line ${String(left.line)} on, ${String(left.bytes)} bytes, is left out, past the ${String(MAX_APPEND / (1024 * 1024))} MiB one session appends`,
      ),
    );
  // What passes the limit is left out, whole lines only, and the full line says so, once.
  const full = note(INTAKE_FULL);
  // Room for the full line and a newline before a cut-off last line, never past the limit.
  let room = MAX_LOG - state.size - (full.length + 2);
  if (room < 0) return;
  const kept: Buffer[] = [];
  let over = false;
  for (const line of [note(intakeMark(session)), ...lines]) {
    if (line.length + 1 > room) {
      over = true;
      break;
    }
    kept.push(line);
    room -= line.length + 1;
  }
  if (over) kept.push(full);
  if (kept.length === 0) return;
  const added = Buffer.concat(kept.flatMap((l) => [l, Buffer.from('\n')]));
  // A crash mid-append can leave a last line with no newline: the marker starts a line of its own.
  const cut = Buffer.from('\n');
  let fd: number;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const flags = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
    fd = openSync(file, flags | constants.O_NONBLOCK, 0o600);
  } catch (err) {
    throw failed('could not open', file, err);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('it is not a regular file');
    const last = Buffer.alloc(1);
    const endsCut =
      stat.size > 0 && readSync(fd, last, 0, 1, stat.size - 1) === 1 && last[0] !== 0x0a;
    const out = endsCut ? Buffer.concat([cut, added]) : added;
    for (let done = 0; done < out.length;) done += writeSync(fd, out, done, out.length - done);
    fsyncSync(fd);
  } catch (err) {
    throw failed('could not append to', file, err);
  } finally {
    closeSync(fd);
  }
}

/**
 * Before the next pass goes on, the last Intake session the item's failure record names, when its
 * lines are not in the item's file: a crash after the session started and before its append, with
 * or without its outcome recorded, leaves exactly that. The record names the last session only,
 * and a session is recovered before the next one is recorded, so it names every session whose
 * lines could be missing but one the Owner's deleting the record forgets (28-5c-4d-1). A session
 * that still runs appends its own lines when it ends; one that never wrote its record has none.
 */
export function recoverIntakeSession(
  home: string,
  repo: string,
  issue: number,
  now: () => Date,
): void {
  const id = readFailureRecord(failureFile(home, repo, issue, 1))?.session;
  if (id === undefined) return;
  if (sessionRunning(home, id) !== undefined) return;
  if (!present(join(home, '.factory', 'sessions', id, 'session.json'))) return;
  appendIntakeSession(home, repo, issue, id, now);
}

/** The role version of a factory line that no release wrote: the seed's "not here" line. */
const NO_RELEASE = 'v0.0.0+000000000000';

/** The seed of an item branch's `events.jsonl`: Intake's lines, and what to alert, if anything. */
export interface IntakeSeed {
  text: string;
  /** An Intake session ran and its lines are not in the file: why, for one alert. */
  missing?: string;
}

/**
 * The first lines of the item branch's `events.jsonl` (design, "Before the branch exists"): the
 * per-item file's lines that are events of this item's Intake, in order, or one line saying
 * Intake's events are not here. It reads no comment. The failure record's session, when it ran
 * and has no marker in the file, is named in `missing`: the lines are lost, so the Owner is told.
 */
export function intakeSeed(home: string, repo: string, issue: number, now: () => Date): IntakeSeed {
  const state = scan(intakeEventsFile(home, repo, issue));
  const lines = state.text.split('\n').filter((line) => {
    try {
      const e = validateEvent(JSON.parse(line));
      return e.item === issue && e.role === 'intake';
    } catch {
      return false;
    }
  });
  const none = JSON.stringify(
    makeEvent(
      {
        ...{ item: issue, station: 1, role: 'intake', role_version: NO_RELEASE },
        ...{ session: 'dispatcher', model: 'none', kind: 'alert', tool: 'Dispatcher' },
        input_summary: "Intake's events are not here: none were kept on the laptop for this item",
      },
      now,
    ),
  );
  const text = `${(lines.length === 0 ? [none] : lines).join('\n')}\n`;
  const id = readFailureRecord(failureFile(home, repo, issue, 1))?.session;
  const ran = id !== undefined && present(join(home, '.factory', 'sessions', id, 'session.json'));
  if (!ran || state.sessions.has(id)) return { text };
  // Full by its line, or too near the limit for an append to fit one (see `appendIntakeSession`).
  const full = state.full || state.size > MAX_LOG - 1024;
  const why = full ? 'the file is full' : 'it was not appended to the file';
  return {
    text,
    missing: `#${String(issue)}: Intake session ${id}'s lines are not in the item's events file, since ${why}; the branch is created without them, and they are only in the session's own log under ~/.factory/sessions/`,
  };
}

/** Whether the item's file exists; anything but its absence throws. */
export const hasIntakeFile = (home: string, repo: string, issue: number): boolean =>
  present(intakeEventsFile(home, repo, issue));

/** Deletes the item's file once its lines are on the pushed branch; a missing file is fine. */
export function dropIntakeFile(home: string, repo: string, issue: number): void {
  const file = intakeEventsFile(home, repo, issue);
  try {
    rmSync(file, { force: true });
  } catch (err) {
    throw failed('could not delete', file, err);
  }
}
