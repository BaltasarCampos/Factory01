// Intake's per-item file (design, Branches, "Before the branch exists"; T086, slice 28-5c-4b):
// each time an Intake session ends, failed ones included, the dispatcher appends that session's
// log to `~/.factory/items/<owner>/<repo>/<issue>/events.jsonl` on the laptop, after one factory
// line naming the session, never overwriting, the attempts in order. Each line is checked as an
// event of that session, and one that is not is replaced by a factory line saying which and why;
// a log missing or unreadable gets one such line. A copied line names its own session alone, so
// no session can write a line that passes for another session's marker. Slice 28-5c-4c reads the
// file: the sessions its markers name, for recovery, and its lines, for the item branch's seed.
// The file is telemetry, never a decision; only its read or write failing stops the pass.
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  fsyncSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { EnvironmentError } from '../cli/env.js';
import { makeEvent } from '../events/append.js';
import { MAX_APPEND } from '../hooks/events-commit.js';
import { readSessionRecord, recordEvent, sessionEvents } from '../hooks/session.js';
import { sessionLines } from '../hooks/session-log.js';
import { visible } from '../notify/summary.js';
import { repoParts } from './failures.js';

/** The item's file of Intake's events, kept until its branch carries them (28-5c-4c). */
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
      if (!fstatSync(fd).isFile()) throw new Error('it is not a regular file');
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
  let fd: number;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const flags =
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
    fd = openSync(file, flags | constants.O_NONBLOCK, 0o600);
  } catch (err) {
    throw failed('could not open', file, err);
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error('it is not a regular file');
    for (let done = 0; done < added.length;)
      done += writeSync(fd, added, done, added.length - done);
    fsyncSync(fd);
  } catch (err) {
    throw failed('could not append to', file, err);
  } finally {
    closeSync(fd);
  }
}
