// Intake's per-item file (T086, slice 28-5c-4b): each ended Intake session's log appended on the
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
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendIntakeSession,
  intakeEventsFile,
  intakeMark,
  intakeSessions,
} from '../../src/dispatcher/intake-events.js';
import { makeEvent } from '../../src/events/append.js';
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

describe("Intake's per-item file (T086, 28-5c-4b)", () => {
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

  it('keeps the lines of a file that already exists byte for byte', () => {
    const t = intake('');
    const before = 'not json at all\n{"kind":"x"}\nno newline';
    mkdirSync(dirname(t.file), { recursive: true });
    writeFileSync(t.file, before);
    t.append();
    const after = readFileSync(t.file, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toContain(intakeMark(SESSION_ID));
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

  it('stops with an error on a file it cannot read or write, never reading it as none', () => {
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
  });
});
