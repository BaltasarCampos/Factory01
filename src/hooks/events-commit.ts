// The events commit (T086, slice 28-5c-3b): at a stop that passes, the session's own log, which
// its hooks wrote under `~/.factory/sessions/<id>/`, is appended to the work item's event log in a
// commit of the factory's own on the head the check passed, and the passing head names that
// commit. Its parent is exactly that head, it changes only the log, every line already there stays
// byte for byte, and the new lines follow. Define's log is `.factory/define/events.jsonl` on
// `claude/define`. The log is telemetry: nothing here is read as a decision.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EnvironmentError } from '../cli/env.js';
import { validateEvent } from '../events/schema.js';
import { safeGit } from '../git/diff.js';
import { visible } from '../notify/summary.js';
import { commitFiles } from './output-commit.js';
import { own } from './session-commits.js';
import { sessionEvents, sessionFolder, type SessionRecord } from './session.js';

/** Define's event log on `claude/define`, which has no feature folder. */
export const DEFINE_EVENTS = '.factory/define/events.jsonl';

/** Where the record's work keeps its event log; the factory's error for a role with none. */
export function eventsPath(record: SessionRecord): string {
  if (record.feature !== '') return `${record.feature}/events.jsonl`;
  if (record.role === 'define') return DEFINE_EVENTS;
  throw new EnvironmentError(
    `a ${record.role} session on ${visible(record.branch)} has no event log to append to: the factory's own error`,
  );
}

/** The session's log lines, each an event, as the hooks wrote them; none for no log. */
function sessionLines(home: string, session: string): Buffer[] {
  const path = sessionEvents(home, session);
  if (!existsSync(path)) return [];
  const text = readFileSync(path);
  const lines: Buffer[] = [];
  let start = 0;
  for (let at = 0; at <= text.length; at += 1) {
    if (at < text.length && text[at] !== 0x0a) continue;
    const line = text.subarray(start, at);
    start = at + 1;
    if (line.length === 0) continue;
    try {
      validateEvent(JSON.parse(line.toString('utf8')));
    } catch (err) {
      throw new EnvironmentError(
        `line ${String(lines.length + 1)} of the session's log is not an event: ${visible(err instanceof Error ? err.message : String(err))}`,
      );
    }
    lines.push(line);
  }
  return lines;
}

/** The log's bytes at `head`, empty when it has none; the factory's error for a link or folder. */
function logAt(repo: string, head: string, path: string, env: NodeJS.ProcessEnv): Buffer {
  const entry = own(repo, ['ls-tree', '--full-tree', head, '--', path], env);
  if (entry.status !== 0)
    throw new EnvironmentError(`git ls-tree in ${repo} failed: ${visible(entry.err)}`);
  if (entry.out === '') return Buffer.alloc(0);
  if (!entry.out.startsWith('100644 blob '))
    throw new EnvironmentError(
      `${visible(path)} at ${head.slice(0, 12)} is not a regular file, so no line can be appended to it`,
    );
  const blob = safeGit(repo, ['cat-file', 'blob', `${head}:${path}`], env);
  if (blob.status !== 0)
    throw new EnvironmentError(`git cat-file in ${repo} failed: ${visible(blob.stderr)}`);
  return blob.stdout;
}

/**
 * The events commit on `head`, the commit the check passed, in the record's `project`; `head`
 * itself when the session's log has no line. Throws when it cannot be made.
 */
export function commitEvents(
  record: SessionRecord,
  home: string,
  session: string,
  head: string,
  env: NodeJS.ProcessEnv,
): string {
  const path = eventsPath(record);
  const lines = sessionLines(home, session);
  if (lines.length === 0) return head;
  const old = logAt(record.project, head, path, env);
  // A last line cut short keeps its bytes; the first new line starts on its own.
  const lead = old.length > 0 && old[old.length - 1] !== 0x0a ? '\n' : '';
  const added = Buffer.concat(lines.flatMap((line) => [line, Buffer.from('\n')]));
  const log = Buffer.concat([old, Buffer.from(lead), added]);
  const work = mkdtempSync(join(sessionFolder(home, session), 'events-'));
  try {
    return commitFiles(record, head, new Map([[path, log]]), work, env, 'events');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
