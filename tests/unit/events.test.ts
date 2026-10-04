import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEvent, eventLogPath, type EventInput } from '../../src/events/append.js';
import { redact } from '../../src/events/redact.js';
import { EventError, roleVersion, validateEvent } from '../../src/events/schema.js';
import { tempDir } from '../helpers/keys.js';

const VERSION = 'v1.0.0+0123456789ab';
const base: EventInput = {
  item: 42,
  station: 4,
  role: 'builder',
  role_version: VERSION,
  session: 'sess-1',
  model: 'claude-sonnet-5-5',
  kind: 'tool_call',
  tool: 'Bash',
  input_summary: 'npm test',
};
const event = { ts: '2026-10-04T09:00:00Z', ...base };
const clock = (iso: string) => () => new Date(iso);

function problems(value: unknown): string[] {
  try {
    validateEvent(value);
  } catch (err) {
    if (err instanceof EventError) return err.problems;
    throw err;
  }
  return [];
}

describe('event schema, data-model.md § Event (AC-048)', () => {
  it('accepts a complete tool_call event', () => {
    expect(validateEvent(event)).toEqual(event);
  });

  it.each([
    ['ts', '2026-10-04 09:00:00'],
    ['ts', '2026-13-40T09:00:00Z'],
    ['ts', 1_728_000_000],
    ['item', -1],
    ['item', 1.5],
    ['station', 9],
    ['station', '4'],
    ['role', 'owner'],
    ['role_version', 'v1.0.0'],
    ['role_version', 'latest+0123456789ab'],
    ['session', ''],
    ['model', ''],
    ['model', 'claude-fable-5-1'],
    ['model', 'FABLE'],
    ['kind', 'chat'],
    ['tool', 7],
    ['input_summary', { command: 'x' }],
  ])('rejects %s = %j', (field, value) => {
    expect(problems({ ...event, [field]: value }).join('\n')).toContain(field);
  });

  it.each(['ts', 'item', 'station', 'role', 'role_version', 'session', 'model', 'kind'])(
    'requires %s',
    (field) => {
      const rest = Object.fromEntries(Object.entries(event).filter(([k]) => k !== field));
      expect(problems(rest).join('\n')).toContain(field);
    },
  );

  it('accepts every kind', () => {
    for (const kind of [
      'tool_call',
      'blocked',
      'approval',
      'alert',
      'split',
      'advance_request',
      'owner_comment',
      'cap',
    ]) {
      expect(problems({ ...event, kind })).toEqual([]);
    }
  });

  it('item 0 stands for project-level work (Define, Release, Ops, Coach)', () => {
    expect(problems({ ...event, item: 0 })).toEqual([]);
  });

  it('gate_result needs gate and pass; evidence is optional; other kinds carry none of them', () => {
    const gate = { ...event, kind: 'gate_result', gate: 'ci / red-green', pass: false };
    expect(problems(gate)).toEqual([]);
    expect(problems({ ...gate, evidence: 'https://github.com/o/p/actions/runs/1' })).toEqual([]);
    expect(problems({ ...gate, gate: undefined }).join()).toContain('gate');
    expect(problems({ ...gate, pass: 'no' }).join()).toContain('pass');
    expect(problems({ ...event, gate: 'x', pass: true }).join()).toMatch(/gate|pass/);
  });

  it('usage events carry { sessions, est_share }; est_share is a share of the plan, 0–1', () => {
    const usage = { ...event, kind: 'usage', usage: { sessions: 2, est_share: 0.04 } };
    expect(problems(usage)).toEqual([]);
    expect(problems({ ...usage, usage: undefined }).join()).toContain('usage');
    expect(problems({ ...usage, usage: { sessions: -1, est_share: 0.1 } }).join()).toContain(
      'usage',
    );
    expect(problems({ ...usage, usage: { sessions: 1, est_share: 1.5 } }).join()).toContain(
      'usage',
    );
    expect(problems({ ...usage, usage: { sessions: 1 } }).join()).toContain('usage');
  });

  it('rejects unknown fields and non-objects', () => {
    expect(problems({ ...event, author: 'agent' }).join()).toContain('author');
    expect(problems(null)).not.toEqual([]);
    expect(problems([event])).not.toEqual([]);
  });

  it('role_version is the factory release plus the role file hash', () => {
    const v = roleVersion('v1.2.3', '---\nname: builder\n---\nbody\n');
    expect(v).toMatch(/^v1\.2\.3\+[0-9a-f]{12}$/);
    expect(roleVersion('v1.2.3', '---\nname: builder\n---\nbody!\n')).not.toBe(v);
    expect(problems({ ...event, role_version: v })).toEqual([]);
  });
});

describe('redaction before write (AC-048)', () => {
  it.each([
    [
      'GitHub token',
      'gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'ghp_abcdefghij',
    ],
    [
      'GitHub fine-grained token',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
      'github_pat_11ABC',
    ],
    ['GitHub app token', 'ghs_abcdefghijklmnopqrstuvwxyz0123456789', 'ghs_abcdefghij'],
    ['API key', 'curl -H "x-api-key: sk-ant-api03-abcdefghijklmnopqrstuvwx"', 'sk-ant-api03-abc'],
    [
      'bearer token',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.0123456789',
      'abcdefghijklmnop',
    ],
    ['AWS key id', 'AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKL'],
    ['env line', 'ANTHROPIC_API_KEY=abc123\nPATH_LIKE=/usr/bin', 'abc123'],
    ['quoted env value', 'export DB_PASSWORD="hunter2 two"', 'hunter2'],
    ['env prefix on a command', 'GH_TOKEN=xyz987 gh pr list', 'xyz987'],
  ])('%s', (_name, text, secret) => {
    const out = redact(text);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('removes a whole PEM block', () => {
    const pem =
      'cat key\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAAbm9uZQ==\n-----END OPENSSH PRIVATE KEY-----\ndone';
    expect(redact(pem)).toBe('cat key\n[REDACTED]\ndone');
  });

  it('keeps ordinary text and variable names', () => {
    expect(redact('npm test -- tests/unit/events.test.ts')).toBe(
      'npm test -- tests/unit/events.test.ts',
    );
    expect(redact('NODE_ENV=production npm start')).toBe('NODE_ENV=[REDACTED] npm start');
    expect(redact('sk-short and ghp_short')).toBe('sk-short and ghp_short');
  });
});

describe('appendEvent (AC-048)', () => {
  it('writes one JSON line with ts from the writer, never from the caller', async () => {
    const file = join(tempDir(), 'events.jsonl');
    const forged = { ...base, ts: '1999-01-01T00:00:00Z' } as EventInput;
    const written = await appendEvent(file, forged, clock('2026-10-04T09:30:00.000Z'));
    expect(written.ts).toBe('2026-10-04T09:30:00.000Z');
    const lines = readFileSync(file, 'utf8').split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('');
    expect(JSON.parse(lines[0] ?? '')).toEqual({ ...base, ts: '2026-10-04T09:30:00.000Z' });
  });

  it('redacts tool, input_summary and evidence before the line is written', async () => {
    const file = join(tempDir(), 'events.jsonl');
    await appendEvent(
      file,
      {
        ...base,
        kind: 'gate_result',
        gate: 'ci / build-test',
        pass: false,
        tool: 'Bash',
        input_summary: 'GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 gh api',
        evidence: 'log: sk-ant-api03-abcdefghijklmnopqrstuvwx',
      },
      clock('2026-10-04T09:30:00Z'),
    );
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/ghp_|sk-ant/);
    expect(text).toContain('[REDACTED]');
  });

  it('only appends: earlier bytes are kept exactly, even a last line missing its newline', async () => {
    const file = join(tempDir(), 'events.jsonl');
    const earlier = '{"old":1}\n{"old":2}';
    writeFileSync(file, earlier);
    await appendEvent(file, base, clock('2026-10-04T09:30:00Z'));
    await appendEvent(file, { ...base, kind: 'blocked' }, clock('2026-10-04T09:31:00Z'));
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith(earlier)).toBe(true);
    const added = text
      .slice(earlier.length)
      .split('\n')
      .filter((l) => l !== '');
    expect(added.map((l) => (JSON.parse(l) as { kind: string }).kind)).toEqual([
      'tool_call',
      'blocked',
    ]);
  });

  it('refuses an invalid event and writes nothing', async () => {
    const file = join(tempDir(), 'events.jsonl');
    await expect(appendEvent(file, { ...base, model: 'claude-fable-5-1' })).rejects.toThrow(
      EventError,
    );
    expect(() => readFileSync(file)).toThrow();
  });

  it('targets specs/<feature>/events.jsonl pre-merge and .factory/events/<yyyy-mm>.jsonl post-merge', () => {
    expect(eventLogPath({ featureDir: '/w/specs/42-add-login' }, '2026-10-04T09:00:00Z')).toBe(
      '/w/specs/42-add-login/events.jsonl',
    );
    expect(eventLogPath({ factoryLog: '/w' }, '2026-10-04T09:00:00Z')).toBe(
      '/w/.factory/events/2026-10.jsonl',
    );
    expect(eventLogPath({ factoryLog: '/w' }, '2026-12-31T23:59:59-02:00')).toBe(
      '/w/.factory/events/2027-01.jsonl',
    );
  });

  it('a post-merge event lands in the month file of its writer-filled ts', async () => {
    const root = tempDir();
    await appendEvent(
      { factoryLog: root },
      { ...base, item: 0, role: 'ops', station: 8 },
      clock('2026-11-02T10:00:00Z'),
    );
    expect(readFileSync(join(root, '.factory', 'events', '2026-11.jsonl'), 'utf8')).toContain(
      '"ops"',
    );
  });
});
