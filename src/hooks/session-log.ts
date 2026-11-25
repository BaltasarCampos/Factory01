// A session's own log, `~/.factory/sessions/<id>/events.jsonl`, as factory code reads it (T086,
// slices 28-5c-4a and 28-5c-4b): the events commit appends it to the work's event log, and the
// dispatcher to Intake's per-item file. Its hooks write it, each line an event of that session;
// the reader never trusts that. It opens the log without following a link, reads at most the
// limit, and keeps whole lines only. A line that is not an event of this session, one naming
// another session included, is replaced by a factory line saying which and why, so no line of a
// session's log can pass for a factory line of another session's.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { validateEvent } from '../events/schema.js';
import { visible } from '../notify/summary.js';

/** Text of at most 300 characters, shown through `visible()`. */
export const brief = (text: string) =>
  visible(text.length > 300 ? `${text.slice(0, 300)}...` : text);

type Read = { missing: true } | { unread: string } | { text: Buffer; size: number };

/** At most `limit` bytes of the log at `path`, never following a link. */
function readLog(path: string, limit: number): Read {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true };
    return { unread: err instanceof Error ? err.message : String(err) };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { unread: 'it is not a regular file' };
    const text = Buffer.alloc(Math.max(0, Math.min(stat.size, limit)));
    let got = 0;
    while (got < text.length) {
      const n = readSync(fd, text, got, text.length - got, got);
      if (n === 0) break;
      got += n;
    }
    return { text: text.subarray(0, got), size: Math.max(stat.size, got) };
  } catch (err) {
    return { unread: err instanceof Error ? err.message : String(err) };
  } finally {
    closeSync(fd);
  }
}

/** Why `line` is not an event of `session`, or undefined when it is one. */
function notEvent(line: Buffer, cut: boolean, session: string): string | undefined {
  if (line.length === 0) return 'it is empty';
  let why: string;
  try {
    const event = validateEvent(JSON.parse(line.toString('utf8')));
    // `Dispatcher` is the factory's own tool, and its lines are the markers of Intake's per-item
    // file: a session's line naming it never passes, whatever session it names.
    if (event.tool === 'Dispatcher') return "it names the factory's own tool, Dispatcher";
    if (event.session === session) return undefined;
    why = `it names session ${event.session}, not this log's`;
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  }
  return cut ? `it is cut short, with no newline at its end: ${why}` : why;
}

/** The lines kept, and where what is left out starts, by line number and its bytes. */
export interface SessionLines {
  lines: Buffer[];
  left?: { line: number; bytes: number };
}

/**
 * The lines of `session`'s log at `path` to append, each that is not one of its events replaced
 * by `note`, at most `budget` bytes of them; or the one note for a log missing or unreadable.
 */
export function sessionLines(
  path: string,
  session: string,
  budget: number,
  note: (summary: string) => Buffer,
): SessionLines {
  const log = readLog(path, Math.max(0, budget));
  if ('missing' in log)
    return {
      lines: [
        note(
          "the session's log was missing, the factory's own fault, since its start check creates it: none of the session's events is here",
        ),
      ],
    };
  if ('unread' in log)
    return {
      lines: [
        note(
          `the session's log could not be read, so none of its events is here: ${brief(log.unread)}`,
        ),
      ],
    };
  const { text } = log;
  const whole = text.length === log.size;
  const lines: Buffer[] = [];
  let used = 0;
  let start = 0;
  let n = 1;
  const left = () => ({ lines, left: { line: n, bytes: log.size - start } });
  for (; start < text.length; n += 1) {
    const end = text.indexOf(0x0a, start);
    // A line the read did not reach the end of is left out, never read as cut short.
    if (end === -1 && !whole) return left();
    const line = text.subarray(start, end === -1 ? text.length : end);
    const why = notEvent(line, end === -1, session);
    const out =
      why === undefined
        ? line
        : note(`line ${String(n)} of the session's log is not an event: ${brief(why)}`);
    if (used + out.length + 1 > budget) return left();
    lines.push(out);
    used += out.length + 1;
    start = end === -1 ? text.length : end + 1;
  }
  return start < log.size ? left() : { lines };
}
