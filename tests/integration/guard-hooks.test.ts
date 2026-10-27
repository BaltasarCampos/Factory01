// The guard hooks (T086): `factory hook path-guard`, `read-guard` and `command-guard` run the
// guards with the session's facts from its record under `~/.factory/sessions/<id>/`, never from the
// clone's `.station.json` or the hook input's `agent_type`; every refusal and every crash blocks
// and appends a `blocked` event with its rule.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/commands.js';
import { roleVersion } from '../../src/events/schema.js';
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
const SHA40 = '3f9a0c1d2e3f4a5b6c7d8e9f0011223344556677';
const roleFile = (role: string) =>
  `---\nname: ${role}\nmodel: sonnet\ntools: Read, Write\nversion: 1\n---\nYou are the ${role}.\n`;

/** A home folder holding the session's record, and a clone, with no git. */
function setUp(record: Record<string, unknown> = {}, { roleFiles = true } = {}) {
  const home = tempDir();
  const clone = join(home, 'factory-work', 'project', '42-add-login');
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  write(
    join(clone, '.factory/config'),
    `factory_release: v1.0.0@${SHA40}\nagents: local\nprofile: typescript\nrepo: owner/project\ninbox_issue: 1\n`,
  );
  if (roleFiles)
    for (const role of ['builder', 'reviewer', 'release', 'intake'])
      write(join(clone, `.claude/agents/${role}.md`), roleFile(role));
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
  };
  write(
    join(home, '.factory/sessions', SESSION, 'session.json'),
    JSON.stringify({ ...fields, clone, ...record }),
  );
  return { home, clone };
}

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
    expect(events(join(at.clone, FEATURE, 'events.jsonl'))).toEqual([]);
  });

  it('block a refusal with its reason and append a blocked event naming the rule', async () => {
    const at = setUp();
    const pushed = await hook('command-guard', at, 'Bash', { command: 'git push' });
    expect(pushed.code).toBe(2);
    expect(pushed.stderr).toMatch(
      /^factory hook command-guard: refused: git push: no session runs/,
    );
    const wrote = await hook('path-guard', at, 'Edit', { file_path: 'src/other.ts' });
    expect(wrote.stderr).toMatch(/refused: src\/other\.ts: not a file the builder role writes/);
    expect(events(join(at.clone, FEATURE, 'events.jsonl'))).toEqual([
      {
        ts: expect.any(String) as string,
        ...{ item: 42, station: 4, role: 'builder', session: SESSION, model: 'sonnet' },
        role_version: roleVersion('v1.0.0', roleFile('builder')),
        kind: 'blocked',
        tool: 'Bash',
        input_summary: 'deny-shell: git push',
      },
      expect.objectContaining({ tool: 'Edit', input_summary: 'not-writable: src/other.ts' }),
    ]);
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

  it('log a fixed-branch role to the factory log, and Intake nowhere, blocking either way', async () => {
    const release = setUp({ role: 'release', station: 7, item: 0, feature: '', files: [] });
    expect((await hook('command-guard', release, 'Bash', { command: 'git tag v1' })).code).toBe(2);
    const month = new Date().toISOString().slice(0, 7);
    expect(events(join(release.clone, `.factory/events/${month}.jsonl`))).toEqual([
      expect.objectContaining({
        role: 'release',
        kind: 'blocked',
        input_summary: 'blocked: git tag v1',
      }),
    ]);
    const intake = setUp({ role: 'intake', station: 1, feature: '', files: [] });
    const refused = await hook('command-guard', intake, 'Bash', { command: 'cat notes.md' });
    expect(refused).toMatchObject({ code: 2 });
    expect(refused.stderr).not.toMatch(/not written/);
  });

  it('block a crash in a guard as an internal error, logged, never allowed', async () => {
    const at = setUp();
    const crashed = await hook('command-guard', at, 'Bash', { command: 'crash' });
    expect(crashed.code).toBe(2);
    expect(crashed.stderr).toContain('refused: command-guard failed: boom \\u{1b}[2J');
    expect(events(join(at.clone, FEATURE, 'events.jsonl'))).toEqual([
      expect.objectContaining({ kind: 'blocked', input_summary: 'internal-error: crash' }),
    ]);
  });

  it('still block when the event cannot be written, saying why', async () => {
    const at = setUp({}, { roleFiles: false });
    const refused = await hook('command-guard', at, 'Bash', { command: 'git push' });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(
      /\(the blocked event was not written: role file \.claude\/agents\/builder\.md not found\)/,
    );
  });

  it('block a tool the hook does not check, a call missing its field, and a missing record', async () => {
    const at = setUp();
    expect((await hook('path-guard', at, 'Bash', { command: 'ls' })).stderr).toMatch(
      /refused: path-guard does not check Bash/,
    );
    expect((await hook('read-guard', at, 'Read', {})).stderr).toMatch(/has no file_path/);
    expect((await hook('command-guard', at, 'Bash', {})).stderr).toMatch(/has no command/);
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
    ] as const) {
      const at = setUp({ [field]: value });
      const result = await hook('command-guard', at, 'Bash', { command: 'npm test' });
      expect(result.stderr, field).toMatch(new RegExp(`session\\.json: bad ${field}$`, 'm'));
    }
  });
});
