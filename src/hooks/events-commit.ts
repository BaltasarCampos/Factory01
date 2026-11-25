// The events commit (T086, slice 28-5c-3b): at a stop that passes, the session's own log, which
// its hooks wrote under `~/.factory/sessions/<id>/`, is appended to the work item's event log in a
// commit of the factory's own on the head the check passed, and the passing head names that
// commit. Its parent is exactly that head, it changes only the log, every line already there stays
// byte for byte, and the new lines follow. Define's log is `.factory/define/events.jsonl` on
// `claude/define`. The log is telemetry: nothing here is read as a decision.
//
// What the session's log holds never costs the session its passing head (slice 28-5c-4a, Owner
// decisions 2026-11-19): a line that is not an event is replaced by a factory alert line saying
// which and why, as Intake's per-item file does (design, Branches); a log that is missing or cannot
// be read gets one such line; and past `MAX_APPEND` of the session's lines, or past `MAX_LOG` for
// the whole file, what does not fit is left out, with one line saying so. Only a git failure or a
// log on the branch that is not a regular file leaves the session with no passing head.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EnvironmentError } from '../cli/env.js';
import { makeEvent } from '../events/append.js';
import { safeGit } from '../git/diff.js';
import { visible } from '../notify/summary.js';
import { commitFiles } from './output-commit.js';
import { own, type SessionOutput } from './session-commits.js';
import { sessionLines } from './session-log.js';
import { recordEvent, sessionEvents, sessionFolder, type SessionRecord } from './session.js';

/** Define's event log on `claude/define`, which has no feature folder. */
export const DEFINE_EVENTS = '.factory/define/events.jsonl';
/** The most of the session's lines one events commit appends. */
export const MAX_APPEND = 4 * 1024 * 1024;
/** The most an event log may hold after an events commit, well under GitHub's 100 MiB a file. */
export const MAX_LOG = 48 * 1024 * 1024;
/** Kept under `MAX_LOG` for the one line that says what was left out. */
const NOTE_ROOM = 4096;
/** The factory's line, once, in a log no session's lines fit in any more (Owner decision 2026-11-19). */
export const LOG_FULL = "the event log is full; later sessions' events are left out";
/** The two limits; only tests pass others, as the launcher's memory-walk stop is for tests (T061). */
export interface EventLimits {
  append: number;
  log: number;
}

/** The work's event log at the head is not a regular file: no line can be appended to it. */
export class LogNotFile extends EnvironmentError {}

/** Where the record's work keeps its event log; the factory's error for a role with none. */
export function eventsPath(record: SessionRecord): string {
  if (record.feature !== '') return `${record.feature}/events.jsonl`;
  if (record.role === 'define') return DEFINE_EVENTS;
  throw new EnvironmentError(
    `a ${record.role} session on ${visible(record.branch)} has no event log to append to: the factory's own error`,
  );
}

/**
 * The paths the session's commits add or change below a folder named `events.jsonl`, in any letter
 * case: one there makes an event log a folder, which no events commit can append to.
 */
export function belowLogs(at: SessionOutput, env: NodeJS.ProcessEnv): string[] {
  const args = ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--diff-filter=d'];
  const diff = own(at.repo, [...args, at.head, at.commit], env);
  if (diff.status !== 0)
    throw new EnvironmentError(`git diff-tree in ${at.repo} failed: ${visible(diff.err)}`);
  return diff.out
    .split('\0')
    .filter((p) => p.toLowerCase().split('/').slice(0, -1).includes('events.jsonl'));
}

const size = (n: number) =>
  n % (1024 * 1024) === 0 ? `${String(n / (1024 * 1024))} MiB` : `${String(n)} bytes`;

/** The log's bytes at `head`, empty when it has none; `LogNotFile` for a link or folder. */
function logAt(record: SessionRecord, head: string, path: string, env: NodeJS.ProcessEnv): Buffer {
  const repo = record.project;
  const entry = own(repo, ['ls-tree', '--full-tree', head, '--', path], env);
  if (entry.status !== 0)
    throw new EnvironmentError(`git ls-tree in ${repo} failed: ${visible(entry.err)}`);
  if (entry.out === '') return Buffer.alloc(0);
  if (!entry.out.startsWith('100644 blob ')) {
    const out =
      record.item === 0
        ? ''
        : `; for an item, the way out is to close it and file it again, until T096`;
    throw new LogNotFile(
      `${path} at ${head.slice(0, 12)} on ${record.branch} is not a regular file, so the session's log cannot be appended to it; only a commit that removes it clears this${out}`,
    );
  }
  const blob = safeGit(repo, ['cat-file', 'blob', `${head}:${path}`], env);
  if (blob.status !== 0)
    throw new EnvironmentError(`git cat-file in ${repo} failed: ${visible(blob.stderr)}`);
  return blob.stdout;
}

/** Whether the log's last line is the factory's `LOG_FULL` line. */
function endsFull(old: Buffer): boolean {
  const end = old.length > 0 && old[old.length - 1] === 0x0a ? old.length - 1 : old.length;
  try {
    const tail = old.subarray(old.lastIndexOf(0x0a, end - 1) + 1, end).toString('utf8');
    const last = JSON.parse(tail) as Record<string, unknown>;
    return last.kind === 'alert' && last.tool === 'Stop' && last.input_summary === LOG_FULL;
  } catch {
    return false;
  }
}

/** The events commit, and the alert for the session's own log when its events are left out. */
export interface EventsCommit {
  commit: string;
  full?: string;
}

/**
 * The events commit on `head`, the commit the check passed, in the record's `project`; `head`
 * itself when there is no line to append. A log the session's lines no longer fit in gets the
 * `LOG_FULL` line once, passing the limit by that line alone, and `full` says so for the session's
 * own log; telemetry never costs the work. Throws only on a git failure or a log at `head` that is
 * not a regular file (`LogNotFile`).
 */
export function commitEvents(
  record: SessionRecord,
  home: string,
  session: string,
  head: string,
  env: NodeJS.ProcessEnv,
  now: () => Date,
  limits: EventLimits = { append: MAX_APPEND, log: MAX_LOG },
): EventsCommit {
  const path = eventsPath(record);
  const old = logAt(record, head, path, env);
  // A last line cut short keeps its bytes; the first new line starts on its own.
  const lead = Buffer.from(old.length > 0 && old[old.length - 1] !== 0x0a ? '\n' : '');
  const room = limits.log - old.length - lead.length;
  const budget = Math.min(limits.append, room - NOTE_ROOM);
  const note = (summary: string) =>
    Buffer.from(
      JSON.stringify(
        makeEvent(
          recordEvent(record, session, { kind: 'alert', tool: 'Stop', input_summary: summary }),
          now,
        ),
      ),
    );
  const { lines, left } = sessionLines(sessionEvents(home, session), session, budget, note);
  if (left !== undefined) {
    const why =
      budget === limits.append
        ? `past the ${size(limits.append)} one events commit appends`
        : `which would take ${path} past ${size(limits.log)}`;
    lines.push(
      note(
        `the session's log from line ${String(left.line)} on, ${String(left.bytes)} bytes, is left out, ${why}`,
      ),
    );
  }
  const lined = (all: Buffer[]) => Buffer.concat(all.flatMap((line) => [line, Buffer.from('\n')]));
  let added = lined(lines);
  if (lines.length === 0) return { commit: head };
  // Once full, nothing more goes in: the full line stays the log's last.
  let full: string | undefined;
  const already = endsFull(old);
  if (already || added.length > room) {
    full = `${path} is full, past ${size(limits.log)}, so none of this session's events is in it; they are only in the session's own log`;
    if (already) return { commit: head, full };
    added = lined([note(LOG_FULL)]);
  }
  const log = Buffer.concat([old, lead, added]);
  const work = mkdtempSync(join(sessionFolder(home, session), 'events-'));
  try {
    const commit = commitFiles(record, head, new Map([[path, log]]), work, env, 'events');
    return full === undefined ? { commit } : { commit, full };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
