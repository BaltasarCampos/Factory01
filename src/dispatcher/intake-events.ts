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
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  fsyncSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { EnvironmentError } from '../cli/env.js';
import { makeEvent } from '../events/append.js';
import { MAX_APPEND, MAX_LOG } from '../hooks/events-commit.js';
import { readSessionRecord, recordEvent, sessionEvents } from '../hooks/session.js';
import { sessionLines } from '../hooks/session-log.js';
import { visible } from '../notify/summary.js';
import { failureFile, readFailureRecord, repoParts } from './failures.js';
import { sessionRunning } from './launcher/local.js';

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

/**
 * The sessions whose marker the file holds, none when it is missing: a marker is the factory's
 * `alert` line by the `Dispatcher` whose text names its own `session` field. Any other read
 * failure throws, never reading as none.
 */
export function intakeSessions(file: string): Set<string> {
  let text: string;
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      const { size } = stat;
      if (!stat.isFile()) throw new Error('it is not a regular file');
      // Bounded as the work's event log is: past it nothing is read, and nothing is appended.
      if (size > MAX_LOG)
        throw new Error(
          `it is ${String(size)} bytes, past the ${String(MAX_LOG / (1024 * 1024))} MiB the factory reads; close the item and file it again, or delete the file`,
        );
      text = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw failed('could not read', file, err);
  }
  const found = new Set<string>();
  for (const line of text.split('\n')) {
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof e !== 'object' || e === null) continue;
    const { kind, tool, session, input_summary: summary } = e as Record<string, unknown>;
    if (kind === 'alert' && tool === 'Dispatcher' && typeof session === 'string')
      if (summary === intakeMark(session)) found.add(session);
  }
  return found;
}

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
  if (intakeSessions(file).has(session)) return;
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
  const added = Buffer.concat(
    [note(intakeMark(session)), ...lines].flatMap((l) => [l, Buffer.from('\n')]),
  );
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
  if (!existsSync(join(home, '.factory', 'sessions', id, 'session.json'))) return;
  appendIntakeSession(home, repo, issue, id, now);
}
