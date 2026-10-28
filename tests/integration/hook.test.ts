import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/commands.js';
import { runStop, type StationChecker } from '../../src/hooks/stop.js';
import { seedState } from '../helpers/fake-gh.js';
import { tempDir } from '../helpers/keys.js';
import { recordSession, ROLE_VERSION, SESSION_ID } from '../helpers/session.js';

const SHA40 = '3f9a0c1d2e3f4a5b6c7d8e9f0011223344556677';
const FEATURE = 'specs/42-add-login';
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * A session's clone whose own config, role files and station manifest name another repository,
 * model, role and item, with no git: the hooks read none of them, the session's record decides.
 */
function workingCopy(): string {
  const dir = tempDir();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  write(
    '.factory/config',
    `factory_release: v9.9.9@${SHA40}\nagents: local\nprofile: typescript\nrepo: other/elsewhere\ninbox_issue: 9\n`,
  );
  for (const role of ['builder', 'intake', 'define'])
    write(`.claude/agents/${role}.md`, '---\nmodel: opus\n---\n');
  write(`${FEATURE}/.station.json`, JSON.stringify({ item: 7, station: 5, role: 'reviewer' }));
  return dir;
}

/** The session's record, a Builder's at station 4 on item 42 unless `record` says otherwise. */
const session = (dir: string, record: Record<string, unknown> = {}) =>
  recordSession({ role: 'builder', station: 4, clone: dir, ...record });

function input(dir: string, extra: Record<string, unknown> = {}) {
  return {
    session_id: SESSION_ID,
    transcript_path: join(dir, 't.jsonl'),
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { stdout: 'ok' },
    agent_type: 'reviewer',
    ...extra,
  };
}

async function hook(event: string, stdin: unknown, env: NodeJS.ProcessEnv = {}) {
  const err: string[] = [];
  const code = await runCli(['hook', event], {
    stdout: { write: () => undefined },
    stderr: { write: (s: string) => void err.push(s) },
    env: { PATH: process.env.PATH ?? '', ...env },
    stdinIsTTY: false,
    unreadAlerts: () => Promise.reject(new Error('hooks must not read the inbox')),
    readStdin: () => Promise.resolve(typeof stdin === 'string' ? stdin : JSON.stringify(stdin)),
  });
  return { code, stderr: err.join('') };
}

function events(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Nothing the hooks write lands in the clone. */
function cloneUntouched(dir: string): void {
  expect(existsSync(join(dir, FEATURE, 'events.jsonl'))).toBe(false);
  expect(existsSync(join(dir, '.factory', 'events'))).toBe(false);
}

describe('factory hook log (FR-021, AC-048)', () => {
  it("logs one tool_call to the session's own log, its facts from the record, never the clone's", async () => {
    const dir = workingCopy();
    const s = session(dir);
    expect(await hook('log', input(dir), s.env)).toEqual({ code: 0, stderr: '' });
    expect(events(s.log)).toEqual([
      {
        ts: expect.any(String) as string,
        item: 42,
        station: 4,
        role: 'builder',
        role_version: ROLE_VERSION,
        session: SESSION_ID,
        model: 'sonnet',
        kind: 'tool_call',
        tool: 'Bash',
        input_summary: 'npm test',
      },
    ]);
    cloneUntouched(dir);
  });

  it('summarises a write by its path, never its content', async () => {
    const dir = workingCopy();
    const s = session(dir);
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const write = {
      tool_name: 'Write',
      tool_input: { file_path: 'src/login.ts', content: secret },
    };
    await hook('log', input(dir, write), s.env);
    const text = readFileSync(s.log, 'utf8');
    expect(text).toContain('"input_summary":"src/login.ts"');
    expect(text).not.toContain('ghp_');
  });

  it.each([
    ['define', 0, 0],
    ['intake', 1, 42],
    ['ops', 8, 0],
  ])("logs %s's calls to its session's own log too", async (role, station, item) => {
    const dir = workingCopy();
    const s = session(dir, { role, station, item, feature: '' });
    expect((await hook('log', input(dir), s.env)).code).toBe(0);
    expect(events(s.log)).toEqual([expect.objectContaining({ role, station, item })]);
    cloneUntouched(dir);
  });

  it.each<[string, Record<string, unknown> | undefined, Record<string, unknown>, RegExp]>([
    ['a session_id that is no session id', {}, { session_id: '../x' }, /is not a session id/],
    ['no record for the session', undefined, {}, /could not be read/],
    ['a malformed record', { station: 9 }, {}, /bad station/],
    ['a record naming a Fable model', { model: 'claude-fable-5-1' }, {}, /model/],
  ])('blocks and writes nothing for %s', async (_name, record, extra, why) => {
    const dir = workingCopy();
    const s =
      record === undefined ? { ...session(dir), env: { HOME: tempDir() } } : session(dir, record);
    const r = await hook('log', input(dir, extra), s.env);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(why);
    expect(existsSync(s.log)).toBe(false);
    cloneUntouched(dir);
  });
});

describe('factory hook entry: fail closed (contracts/hooks.md)', () => {
  it('unparseable stdin blocks', async () => {
    const r = await hook('log', '{not json');
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/hook input/);
    expect((await hook('log', '[]')).stderr).toMatch(/not a JSON object/);
  });

  // The guard and session-start hooks are in tests/integration/guard-hooks.test.ts (slice 28-1).
  it.each(['pre-compact', 'nope'])('%s is not in this build, so it blocks', async (event) => {
    const r = await hook(event, input(workingCopy()));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/not available/);
  });
});

describe('factory hook stop (AC-063)', () => {
  const stop = (dir: string) => input(dir, { hook_event_name: 'Stop', stop_hook_active: false });

  it("blocks a stop when no output checker exists for the station, and logs the block in the session's log", async () => {
    const dir = workingCopy();
    const s = session(dir, { role: 'integrator', station: 6 });
    const r = await hook('stop', stop(dir), s.env);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/no output checker for station 6/);
    expect(events(s.log)).toEqual([
      expect.objectContaining({
        role: 'integrator',
        kind: 'blocked',
        tool: 'Stop',
        input_summary: expect.stringMatching(/no output checker/) as string,
      }),
    ]);
    cloneUntouched(dir);
  });

  it("checks the record's station in the record's clone; ends when the check passes, keeps going when it fails", async () => {
    const dir = workingCopy();
    const s = session(dir);
    const ctx = { cwd: tempDir(), now: () => new Date(), env: s.env };
    const pass: StationChecker = (r) => ({ complete: r.clone === dir && r.role === 'builder' });
    const fail: StationChecker = () => ({ complete: false, missing: ['plan.md'] });
    expect(await runStop(stop(dir), ctx, { 4: pass })).toEqual({ block: false });
    expect(await runStop(stop(dir), ctx, { 4: fail })).toEqual({
      block: true,
      reason: expect.stringContaining('plan.md') as string,
    });
  });

  it("shows the check's text, which can quote the clone's files, through visible()", async () => {
    const dir = workingCopy();
    const s = session(dir);
    const ctx = { cwd: dir, now: () => new Date(), env: s.env };
    const fail: StationChecker = () => ({ complete: false, missing: ['plan\u202emd'] });
    const { reason } = await runStop(stop(dir), ctx, { 4: fail });
    expect(reason).toContain('plan\\u{202e}md');
    expect(reason).not.toContain('\u202e');
  });

  it.each([
    ['a Fable model', { model: 'claude-fable-5-1' }, /bad model/],
    ['a Builder at Verify, which would run its check', { station: 5 }, /bad station/],
  ])('blocks a stop for a record naming %s', async (_name, record, why) => {
    const dir = workingCopy();
    const s = session(dir, record);
    const r = await hook('stop', stop(dir), s.env);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(why);
  });

  it('Intake whose record names no item cannot end (fails closed)', async () => {
    const dir = workingCopy();
    const s = session(dir, { role: 'intake', station: 1, item: 0, feature: '' });
    const r = await hook('stop', stop(dir), s.env);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/the session's record names no item/);
  });

  it.each([
    ['ends once its labels are complete', ['type:feature', 'priority:p2', 'tier:2'], false],
    ['keeps going while a label is missing, and logs the block', ['tier:2'], true],
  ])("Intake checks the record's repository and item, and %s", async (_name, labels, block) => {
    // The clone's config names other/elsewhere, which the fake GitHub does not have.
    seedState({ repos: { 'owner/project': { issues: [{ number: 42, labels }] } } });
    const dir = workingCopy();
    const s = session(dir, { role: 'intake', station: 1, feature: '' });
    const result = await runStop(stop(dir), { cwd: dir, now: () => new Date(), env: s.env });
    expect(result.block).toBe(block);
    expect(events(s.log)).toEqual(block ? [expect.objectContaining({ kind: 'blocked' })] : []);
  });

  it('after one forced continuation the session may end; the dispatcher still finds no output', async () => {
    const dir = workingCopy();
    const r = await hook('stop', input(dir, { hook_event_name: 'Stop', stop_hook_active: true }));
    expect(r.code).toBe(0);
  });
});

// Prettier and tsc run for real: seconds each, more under a full parallel run.
describe('factory hook post-edit (FR-021)', { timeout: 60_000 }, () => {
  function tsProject(): string {
    const dir = workingCopy();
    symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'));
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: 'nodenext',
          target: 'es2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    );
    mkdirSync(join(dir, 'src'));
    return dir;
  }
  const edit = (dir: string, file: string) =>
    input(dir, { tool_name: 'Edit', tool_input: { file_path: join(dir, file) } });

  it('formats the touched TypeScript file with Prettier', async () => {
    const dir = tsProject();
    writeFileSync(join(dir, 'src', 'ok.ts'), 'export const   x : number=1\n');
    expect((await hook('post-edit', edit(dir, 'src/ok.ts'))).code).toBe(0);
    expect(readFileSync(join(dir, 'src', 'ok.ts'), 'utf8')).toBe('export const x: number = 1;\n');
  });

  it('reports type errors in the touched file to the session', async () => {
    const dir = tsProject();
    writeFileSync(join(dir, 'src', 'bad.ts'), 'export const x: number = "one";\n');
    writeFileSync(join(dir, 'src', 'other.ts'), 'export const y: string = 2;\n');
    const r = await hook('post-edit', edit(dir, 'src/bad.ts'));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/bad\.ts.*TS2322/s);
    expect(r.stderr).not.toContain('other.ts');
  });

  it('leaves files that are not TypeScript alone', async () => {
    const dir = tsProject();
    writeFileSync(join(dir, 'notes.md'), '#  messy   markdown\n');
    expect((await hook('post-edit', edit(dir, 'notes.md'))).code).toBe(0);
    expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toBe('#  messy   markdown\n');
  });

  it('blocks when the project has no Prettier to run', async () => {
    const dir = workingCopy();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    const r = await hook('post-edit', edit(dir, 'src/a.ts'));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/prettier/i);
  });

  it('reports a file Prettier cannot parse', async () => {
    const dir = tsProject();
    writeFileSync(join(dir, 'src', 'broken.ts'), 'export const = ;\n');
    const r = await hook('post-edit', edit(dir, 'src/broken.ts'));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/prettier failed on .*broken\.ts/);
  });

  it('reports project-level tsc errors such as a broken tsconfig.json', async () => {
    const dir = tsProject();
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'es1066' } }),
    );
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    const r = await hook('post-edit', edit(dir, 'src/a.ts'));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/error TS\d+/);
  });

  it('reports a project without tsconfig.json instead of type-checking blind', async () => {
    const dir = tsProject();
    rmSync(join(dir, 'tsconfig.json'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    const r = await hook('post-edit', edit(dir, 'src/a.ts'));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/no tsconfig\.json/);
  });
});
