// Intake's per-item file (T086, slice 28-5c-4c): each ended Intake session's log appended on the
// laptop after the factory's marker, once, every line checked as one of that session's events.
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendIntakeSession,
  INTAKE_FULL,
  intakeEventsFile,
  intakeMark,
  intakeSessions,
  recoverIntakeSession,
} from '../../src/dispatcher/intake-events.js';
import { makeEvent } from '../../src/events/append.js';
import { failureFile, writeFailureRecord } from '../../src/dispatcher/failures.js';
import { MAX_LOG } from '../../src/hooks/events-commit.js';
import { readSessionRecord, recordEvent, sessionEvents } from '../../src/hooks/session.js';
import { recordSession, SESSION_ID } from '../helpers/session.js';

const REPO = 'owner/project';
const now = () => new Date('2026-11-19T12:00:00Z');

/** An ended Intake session of #42 and its log, `log` written as is. */
function intake(log?: string) {
  const { home, log: path } = recordSession({ role: 'intake', station: 1, clone: '/tmp/x' });
  if (log !== undefined) writeFileSync(path, log);
  const file = intakeEventsFile(home, REPO, 42);
  const line = (fields: Record<string, unknown> = {}, session = SESSION_ID) =>
    JSON.stringify(
      makeEvent(
        recordEvent(readSessionRecord(home, SESSION_ID), session, {
          kind: 'tool_call',
          tool: 'Bash',
          input_summary: 'gh issue view 42',
          ...fields,
        }),
        now,
      ),
    );
  const append = (session = SESSION_ID) => {
    appendIntakeSession(home, REPO, 42, session, now);
  };
  const lines = () =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { home, path, file, line, append, lines };
}

describe("Intake's per-item file (T086, 28-5c-4c)", () => {
  it("appends the marker and then the session's lines, its folders 0700 and the file 0600", () => {
    const t = intake();
    writeFileSync(t.path, `${t.line()}\n${t.line({ input_summary: 'second' })}\n`);
    t.append();
    expect(t.file).toBe(join(t.home, '.factory/items/owner/project/42/events.jsonl'));
    expect(t.lines().map((e) => e.input_summary)).toEqual([
      intakeMark(SESSION_ID),
      'gh issue view 42',
      'second',
    ]);
    expect(t.lines()[0]).toMatchObject({ kind: 'alert', tool: 'Dispatcher', role: 'intake' });
    expect(statSync(t.file).mode & 0o777).toBe(0o600);
    for (const folder of [dirname(t.file), join(t.home, '.factory/items/owner')])
      expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(intakeSessions(t.file)).toEqual(new Set([SESSION_ID]));
  });

  it('appends a session once, and a later session after it, the attempts in order', () => {
    const t = intake('');
    t.append();
    t.append();
    const later = randomUUID();
    mkdirSync(dirname(sessionEvents(t.home, later)), { recursive: true });
    const record = readFileSync(join(dirname(t.path), 'session.json'));
    writeFileSync(join(dirname(sessionEvents(t.home, later)), 'session.json'), record);
    writeFileSync(sessionEvents(t.home, later), `${t.line({}, later)}\n`);
    t.append(later);
    expect(t.lines().map((e) => e.session)).toEqual([SESSION_ID, later, later]);
    expect(intakeSessions(t.file)).toEqual(new Set([SESSION_ID, later]));
  });

  it.each([
    ['a line that is not JSON', (g: string) => `${g}\nnot json\n`, /^line 2 .* not valid JSON/],
    [
      "a line of another session's",
      (g: string) => `${g.replace(SESSION_ID, randomUUID())}\n`,
      /^line 1 of the session's log is not an event: it names session [0-9a-f-]{36}, not this log's$/,
    ],
  ])('replaces %s with a factory line', (_name, log, why) => {
    const t = intake();
    writeFileSync(t.path, log(t.line()));
    t.append();
    const notes = t.lines().filter((e) => e.tool === 'Dispatcher');
    expect(notes.at(-1)?.input_summary).toMatch(why);
  });

  it("gives a missing log one factory line, after the session's marker", () => {
    const t = intake();
    rmSync(t.path, { force: true });
    t.append();
    expect(t.lines().map((e) => e.input_summary)).toEqual([
      intakeMark(SESSION_ID),
      expect.stringMatching(/^the session's log was missing/) as string,
    ]);
  });

  it("never reads a session's line that looks like another session's marker as that marker", () => {
    const t = intake();
    const other = randomUUID();
    const forged = t.line(
      { kind: 'alert', tool: 'Dispatcher', input_summary: intakeMark(other) },
      other,
    );
    writeFileSync(t.path, `${forged}\n`);
    t.append();
    expect(intakeSessions(t.file)).toEqual(new Set([SESSION_ID]));
    expect(readFileSync(t.file, 'utf8')).not.toContain(intakeMark(other));
  });

  it("never reads a session's own line naming the Dispatcher as its marker, even for its own session", () => {
    const t = intake();
    const own = t.line({
      kind: 'alert',
      tool: 'Dispatcher',
      input_summary: intakeMark(SESSION_ID),
    });
    writeFileSync(t.path, `${own}\n`);
    t.append();
    const marks = t.lines().filter((e) => e.input_summary === intakeMark(SESSION_ID));
    expect(marks).toHaveLength(1);
    expect(t.lines().at(-1)?.input_summary).toMatch(
      /^line 1 of the session's log is not an event: it names the factory's own tool, Dispatcher$/,
    );
  });

  it('reads a file past the work log limit as an error, naming the way out, and appends nothing', () => {
    const t = intake('');
    mkdirSync(dirname(t.file), { recursive: true });
    writeFileSync(t.file, '');
    truncateSync(t.file, MAX_LOG + 1);
    expect(() => intakeSessions(t.file)).toThrow(
      /^could not read Intake's events file .*: it is \d+ bytes, past the 48 MiB .*close the item and file it again, or delete the file/,
    );
    expect(t.append).toThrow(/past the 48 MiB/);
    expect(statSync(t.file).size).toBe(MAX_LOG + 1);
  });

  it('leaves out what would pass the limit, whole lines only, with the full line once, and a later session adds nothing (28-5c-4d-2)', () => {
    const t = intake('');
    mkdirSync(dirname(t.file), { recursive: true });
    const room = 4000;
    writeFileSync(t.file, '');
    truncateSync(t.file, MAX_LOG - room);
    const log = Array.from({ length: 40 }, (_v, i) =>
      t.line({ input_summary: `line ${String(i)}` }),
    );
    writeFileSync(t.path, `${log.join('\n')}\n`);
    t.append();
    const size = statSync(t.file).size;
    expect(size).toBeLessThanOrEqual(MAX_LOG);
    const text = readFileSync(t.file, 'utf8').slice(MAX_LOG - room);
    const lines = text.split('\n').filter((l) => l !== '' && l.startsWith('{'));
    const summaries = lines.map((l) => (JSON.parse(l) as { input_summary: string }).input_summary);
    expect(summaries[0]).toBe(intakeMark(SESSION_ID));
    expect(summaries.at(-1)).toBe(INTAKE_FULL);
    expect(summaries.filter((x) => x === INTAKE_FULL)).toHaveLength(1);
    expect(summaries.length).toBeGreaterThan(2);
    expect(summaries.length).toBeLessThan(42);
    // Whole lines only: every line kept parses.
    expect(lines.every((l) => (JSON.parse(l) as unknown) !== null)).toBe(true);
    expect(intakeSessions(t.file)).toEqual(new Set([SESSION_ID]));

    // A later session adds nothing, not even its marker.
    const later = randomUUID();
    const folder = dirname(sessionEvents(t.home, later));
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, 'session.json'),
      readFileSync(join(dirname(t.path), 'session.json')),
    );
    writeFileSync(sessionEvents(t.home, later), `${t.line({}, later)}\n`);
    t.append(later);
    expect(statSync(t.file).size).toBe(size);
    expect(intakeSessions(t.file)).toEqual(new Set([SESSION_ID]));
  }, 60_000);

  it('never reads a session folder it cannot look into as one that ran no session (28-5c-4d-2)', () => {
    const t = intake('');
    const id = randomUUID();
    const sessions = join(t.home, '.factory', 'sessions');
    writeFileSync(join(sessions, id), '');
    writeFailureRecord(failureFile(t.home, REPO, 42, 1), {
      ...{ factory: 'a'.repeat(64), count: 1, session: id },
    });
    expect(() => {
      recoverIntakeSession(t.home, REPO, 42, now);
    }).toThrow(/cannot be read: ENOTDIR/);
    expect(existsSync(t.file)).toBe(false);
  });

  it('keeps the lines of a file that already exists byte for byte', () => {
    const t = intake('');
    const before = 'not json at all\n{"kind":"x"}\nno newline';
    mkdirSync(dirname(t.file), { recursive: true });
    writeFileSync(t.file, before);
    t.append();
    const after = readFileSync(t.file, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toContain(intakeMark(SESSION_ID));
    // The cut line stays as it was, and the marker starts a line of its own: the session is found.
    expect(after.slice(before.length).startsWith(`\n{`)).toBe(true);
    expect(intakeSessions(t.file)).toEqual(new Set([SESSION_ID]));
  });

  it('refuses a link planted at the file, leaving its target untouched', () => {
    const t = intake('');
    const target = join(t.home, 'elsewhere');
    writeFileSync(target, 'theirs\n');
    mkdirSync(dirname(t.file), { recursive: true });
    symlinkSync(target, t.file);
    expect(t.append).toThrow(/^could not read Intake's events file .*events\.jsonl: /);
    expect(readFileSync(target, 'utf8')).toBe('theirs\n');
  });

  it.skipIf(process.getuid?.() === 0)(
    'stops with an error on a file it cannot read or write, never reading it as none',
    () => {
      const t = intake('');
      mkdirSync(t.file, { recursive: true });
      expect(() => intakeSessions(t.file)).toThrow(/it is not a regular file/);
      rmSync(t.file, { recursive: true });
      mkdirSync(dirname(t.file), { recursive: true });
      chmodSync(dirname(t.file), 0o500);
      try {
        expect(t.append).toThrow(/^could not open Intake's events file /);
      } finally {
        chmodSync(dirname(t.file), 0o700);
      }
      expect(existsSync(t.file)).toBe(false);
    },
  );
});
