// The guard hooks (T086): `factory hook path-guard`, `read-guard` and `command-guard` run the
// guards with the session's facts from its record under `~/.factory/sessions/<id>/`, never from the
// clone's `.station.json` or the hook input's `agent_type`; every refusal and every crash blocks
// and appends a `blocked` event with its rule.
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/commands.js';
import { tempDir } from '../helpers/keys.js';

// A command that makes the command guard throw, for the crash case.
vi.mock('../../src/guard/command-guard.js', async (original) => {
  const real = await original<typeof import('../../src/guard/command-guard.js')>();
  return {
    ...real,
    checkBash: (...args: Parameters<typeof real.checkBash>) => {
      if (args[1].command === 'crash') throw new Error('boom \u001b[2J');
      return real.checkBash(...args);
    },
  };
});

const SESSION = '0b6c7f3e-2a4d-4c1e-9f00-1234567890ab';
const FEATURE = 'specs/42-add-login';
const VERSION = 'v1.0.0+0123456789ab';

/** A home folder holding the session's record, and a clone, with no git. */
function setUp(record: Record<string, unknown> = {}) {
  const home = tempDir();
  const clone = join(home, 'factory-work', 'project', '42-add-login');
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  // The hooks never read the clone's config or role files: these would fail if they did.
  write(join(clone, '.factory/config'), 'factory_release: \u001b[2Jnot a pin\n');
  write(join(clone, '.claude/agents/builder.md'), '---\nmodel: opus\n---\n');
  write(join(clone, 'src/login.ts'), 'x');
  write(join(clone, FEATURE, 'events.jsonl'), '');
  // The clone's own manifest says Reviewer: the record, not this, decides.
  write(join(clone, FEATURE, '.station.json'), JSON.stringify({ role: 'reviewer', item: 42 }));
  const fields = {
    role: 'builder',
    item: 42,
    station: 4,
    feature: FEATURE,
    files: ['src/login.ts'],
    model: 'sonnet',
    role_version: VERSION,
  };
  write(
    join(home, '.factory/sessions', SESSION, 'session.json'),
    JSON.stringify({ ...fields, clone, ...record }),
  );
  return { home, clone };
}

/** The session's own event log, under `~/.factory/sessions/<id>/`. */
const sessionLog = (home: string) => join(home, '.factory/sessions', SESSION, 'events.jsonl');

async function hook(
  event: string,
  { home, clone }: { home: string; clone: string },
  tool: string,
  toolInput: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const err: string[] = [];
  const stdin = {
    session_id: SESSION,
    cwd: clone,
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: toolInput,
    agent_type: 'builder',
    ...extra,
  };
  const code = await runCli(['hook', event], {
    stdout: { write: () => undefined },
    stderr: { write: (s: string) => void err.push(s) },
    env: { PATH: process.env.PATH ?? '', HOME: home },
    stdinIsTTY: false,
    unreadAlerts: () => Promise.reject(new Error('hooks must not read the inbox')),
    readStdin: () => Promise.resolve(JSON.stringify(stdin)),
  });
  return { code, stderr: err.join('') };
}

const events = (path: string) =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

describe('the guard hooks (T086)', () => {
  it('allow what the guards allow, and log nothing', async () => {
    const at = setUp();
    expect(await hook('command-guard', at, 'Bash', { command: 'npm test' })).toEqual({
      code: 0,
      stderr: '',
    });
    expect(await hook('path-guard', at, 'Write', { file_path: 'src/login.ts' })).toMatchObject({
      code: 0,
    });
    expect(await hook('read-guard', at, 'Read', { file_path: 'src/login.ts' })).toMatchObject({
      code: 0,
    });
    expect(events(sessionLog(at.home))).toEqual([]);
  });

  it("block a refusal with its reason and append a blocked event naming the rule to the session's own log", async () => {
    const at = setUp();
    const pushed = await hook('command-guard', at, 'Bash', { command: 'git push' });
    expect(pushed.code).toBe(2);
    expect(pushed.stderr).toMatch(
      /^factory hook command-guard: refused: git push: no session runs/,
    );
    const wrote = await hook('path-guard', at, 'Edit', { file_path: 'src/other.ts' });
    expect(wrote.stderr).toMatch(/refused: src\/other\.ts: not a file the builder role writes/);
    // The model and role version come from the record; nothing is written into the clone.
    expect(events(sessionLog(at.home))).toEqual([
      {
        ts: expect.any(String) as string,
        ...{ item: 42, station: 4, role: 'builder', session: SESSION, model: 'sonnet' },
        role_version: VERSION,
        kind: 'blocked',
        tool: 'Bash',
        input_summary: 'deny-shell: git push',
      },
      expect.objectContaining({ tool: 'Edit', input_summary: 'not-writable: src/other.ts' }),
    ]);
    expect(readFileSync(join(at.clone, FEATURE, 'events.jsonl'), 'utf8')).toBe('');
  });

  it("take the role from the session's record, not the clone's .station.json or agent_type", async () => {
    const at = setUp();
    // The Builder may write its task's file though agent_type and the clone say Reviewer.
    const asReviewer = { agent_type: 'reviewer' };
    expect(
      (await hook('path-guard', at, 'Write', { file_path: 'src/login.ts' }, asReviewer)).code,
    ).toBe(0);
    const reviewer = setUp({ role: 'reviewer', station: 5 });
    const read = await hook('read-guard', reviewer, 'Read', {
      file_path: `${FEATURE}/events.jsonl`,
    });
    expect(read.stderr).toMatch(/the Reviewer does not read the event logs/);
  });

  it("record every role's blocks in the session's log, Define's and Intake's included", async () => {
    for (const role of ['release', 'define', 'intake'] as const) {
      const at = setUp({ role, station: { release: 7, define: 0, intake: 1 }[role], item: 0 });
      const refused = await hook('command-guard', at, 'Bash', { command: 'git tag v1' });
      expect(refused.code, role).toBe(2);
      expect(refused.stderr, role).not.toMatch(/not written/);
      expect(events(sessionLog(at.home)), role).toEqual([
        expect.objectContaining({ role, kind: 'blocked', tool: 'Bash' }),
      ]);
      expect(existsSync(join(at.clone, '.factory/events')), role).toBe(false);
    }
  });

  it('block a crash in a guard as an internal error, logged, never allowed', async () => {
    const at = setUp();
    const crashed = await hook('command-guard', at, 'Bash', { command: 'crash' });
    expect(crashed.code).toBe(2);
    expect(crashed.stderr).toContain('refused: command-guard failed: boom \\u{1b}[2J');
    expect(events(sessionLog(at.home))).toEqual([
      expect.objectContaining({ kind: 'blocked', input_summary: 'internal-error: crash' }),
    ]);
  });

  it('still block when the event cannot be written, saying why', async () => {
    const at = setUp();
    mkdirSync(sessionLog(at.home), { recursive: true });
    const refused = await hook('command-guard', at, 'Bash', { command: 'git push' });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/\(the blocked event was not written: EISDIR/);
  });

  it('block a tool the hook does not check, a call missing its field, and a missing record', async () => {
    const at = setUp();
    expect((await hook('path-guard', at, 'Bash', { command: 'ls' })).stderr).toMatch(
      /refused: path-guard does not check Bash/,
    );
    const odd = await hook('path-guard', at, 'Bash\u001b[2J', { command: 'ls' });
    expect(odd.stderr).toContain('does not check Bash\\u{1b}[2J');
    expect((await hook('read-guard', at, 'Read', {})).stderr).toMatch(/has no file_path/);
    expect((await hook('command-guard', at, 'Bash', {})).stderr).toMatch(/has no command/);
    expect((await hook('read-guard', at, 'Glob', {})).stderr).toMatch(/has no pattern/);
    const other = await hook(
      'command-guard',
      at,
      'Bash',
      { command: 'npm test' },
      {
        session_id: '1b6c7f3e-2a4d-4c1e-9f00-1234567890ab',
      },
    );
    expect(other).toMatchObject({ code: 2 });
    expect(other.stderr).toMatch(/the session's record .* could not be read/);
    const forged = await hook(
      'command-guard',
      at,
      'Bash',
      { command: 'npm test' },
      {
        session_id: '../../x',
      },
    );
    expect(forged.stderr).toMatch(/session_id "\.\.\/\.\.\/x" is not a session id/);
  });

  it('block a malformed record', async () => {
    for (const [field, value] of [
      ['role', 'nobody'],
      ['station', 9],
      ['files', 'src/login.ts'],
      ['clone', 'relative/clone'],
      ['model', ''],
      ['role_version', 5],
    ] as const) {
      const at = setUp({ [field]: value });
      const result = await hook('command-guard', at, 'Bash', { command: 'npm test' });
      expect(result.stderr, field).toMatch(new RegExp(`session\\.json: bad ${field}$`, 'm'));
    }
  });

  it('block a field that is present but not a string, rather than reading it as absent', async () => {
    const at = setUp();
    for (const [event, tool, input] of [
      ['command-guard', 'Bash', { command: ['git', 'push'] }],
      ['path-guard', 'Write', { file_path: 7 }],
      ['read-guard', 'Read', { file_path: null }],
      ['read-guard', 'Grep', { pattern: 'x', path: ['/'] }],
      ['read-guard', 'Grep', { pattern: 'x', glob: { a: 1 } }],
      ['read-guard', 'Glob', { pattern: 3 }],
    ] as const) {
      const result = await hook(event, at, tool, input);
      const field = Object.keys(input).at(-1) ?? '';
      expect(result, field).toMatchObject({ code: 2 });
      expect(result.stderr, field).toMatch(
        new RegExp(`the ${tool} call's ${field} is not a string`),
      );
    }
  });
});

describe("the read guard on a Glob's pattern (T085)", () => {
  const glob = (at: { home: string; clone: string }, input: Record<string, unknown>) =>
    hook('read-guard', at, 'Glob', input);

  it('allow a pattern inside the clone', async () => {
    const at = setUp();
    expect(await glob(at, { pattern: 'src/**/*.ts' })).toMatchObject({ code: 0 });
    expect(await glob(at, { pattern: '*.ts', path: 'src' })).toMatchObject({ code: 0 });
    expect(await glob(at, { pattern: 'src/../specs/*' })).toMatchObject({ code: 0 });
  });

  it('refuse an absolute pattern, one that leaves the clone with .., and one with braces', async () => {
    const at = setUp();
    for (const [pattern, reason] of [
      [`${at.home}/.ssh/*`, /is absolute; give the folder as path/],
      ['~/.ssh/*', /is absolute; give the folder as path/],
      ['../../../.ssh/*', /leaves the clone/],
      ['../../../**', /leaves the clone/],
      ['src/*/../../../../../*', /has \.\. after a glob character/],
      ['*.{ts,js}', /has braces; give one pattern without braces/],
    ] as const) {
      const result = await glob(at, { pattern });
      expect(result, pattern).toMatchObject({ code: 2 });
      expect(result.stderr, pattern).toMatch(reason);
    }
    expect(events(sessionLog(at.home))[0]).toMatchObject({
      input_summary: `search: ${at.home}/.ssh/*`,
    });
  });

  it("refuse a pattern a relative deny_read pattern matches, and check the pattern's leading folder", async () => {
    const at = setUp();
    expect((await glob(at, { pattern: '**/.env*' })).stderr).toMatch(
      /the pattern \*\*\/\.env\* names files no session reads/,
    );
    mkdirSync(join(at.clone, '.env.d'));
    expect((await glob(at, { pattern: '.env.d/*' })).stderr).toMatch(/no session reads it/);
    // The leading folder is checked where it really is, through a symlink.
    mkdirSync(join(at.home, '.ssh'));
    symlinkSync(join(at.home, '.ssh'), join(at.clone, 'keys'));
    const linked = await glob(at, { pattern: 'keys/*' });
    expect(linked).toMatchObject({ code: 2 });
    expect(linked.stderr).toMatch(/no session reads it \(~\/\.ssh\/\*\*\)/);
  });
});
