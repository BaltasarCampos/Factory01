import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/commands.js';
import { roleVersion } from '../../src/events/schema.js';
import { runStop, type StationChecker } from '../../src/hooks/stop.js';
import { tempDir } from '../helpers/keys.js';

const SHA40 = '3f9a0c1d2e3f4a5b6c7d8e9f0011223344556677';
const FEATURE = 'specs/42-add-login';
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function roleFile(role: string, model = 'sonnet'): string {
  return `---\nname: ${role}\nmodel: ${model}\ntools: Read, Write\nversion: 1\n---\nYou are the ${role}.\n`;
}

/** A project working copy on an item branch with a Builder station manifest. */
function workingCopy(opts: { manifestRole?: string; model?: string } = {}): string {
  const dir = tempDir();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  write(
    '.factory/config',
    `factory_release: v1.0.0@${SHA40}\nagents: local\nprofile: typescript\nrepo: owner/project\ninbox_issue: 1\n`,
  );
  for (const role of ['builder', 'ops', 'define', 'intake', 'spec'])
    write(`.claude/agents/${role}.md`, roleFile(role, opts.model));
  write('.specify/feature.json', JSON.stringify({ feature_directory: FEATURE }));
  write(
    `${FEATURE}/.station.json`,
    JSON.stringify({
      item: 42,
      station: 4,
      role: opts.manifestRole ?? 'builder',
      branch: 'claude/42-add-login',
      task: 'T007',
      files: ['src/login.ts'],
      issued_at: '2026-10-04T09:00:00Z',
    }),
  );
  return dir;
}

function input(dir: string, extra: Record<string, unknown> = {}) {
  return {
    session_id: 'sess-1',
    transcript_path: join(dir, 't.jsonl'),
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { stdout: 'ok' },
    agent_type: 'builder',
    ...extra,
  };
}

async function hook(event: string, stdin: unknown) {
  const err: string[] = [];
  const code = await runCli(['hook', event], {
    stdout: { write: () => undefined },
    stderr: { write: (s: string) => void err.push(s) },
    env: { PATH: process.env.PATH ?? '' },
    stdinIsTTY: false,
    unreadAlerts: () => Promise.reject(new Error('hooks must not read the inbox')),
    readStdin: () => Promise.resolve(typeof stdin === 'string' ? stdin : JSON.stringify(stdin)),
  });
  return { code, stderr: err.join('') };
}

function events(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('factory hook log (FR-021, AC-048)', () => {
  it('an item role logs one tool_call to its feature events.jsonl, with item and station from .station.json', async () => {
    const dir = workingCopy();
    expect(await hook('log', input(dir))).toEqual({ code: 0, stderr: '' });
    const [line] = events(join(dir, FEATURE, 'events.jsonl'));
    expect(line).toEqual({
      ts: expect.any(String) as string,
      item: 42,
      station: 4,
      role: 'builder',
      role_version: roleVersion('v1.0.0', roleFile('builder')),
      session: 'sess-1',
      model: 'sonnet',
      kind: 'tool_call',
      tool: 'Bash',
      input_summary: 'npm test',
    });
  });

  it('summarises a write by its path, never its content', async () => {
    const dir = workingCopy();
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    await hook(
      'log',
      input(dir, {
        tool_name: 'Write',
        tool_input: { file_path: 'src/login.ts', content: secret },
      }),
    );
    const text = readFileSync(join(dir, FEATURE, 'events.jsonl'), 'utf8');
    expect(text).toContain('"input_summary":"src/login.ts"');
    expect(text).not.toContain('ghp_');
  });

  it('a claude/factory-log role logs to .factory/events/<yyyy-mm>.jsonl as project-level work', async () => {
    const dir = workingCopy();
    expect((await hook('log', input(dir, { agent_type: 'ops' }))).code).toBe(0);
    const [month] = readdirSync(join(dir, '.factory', 'events'));
    expect(month).toMatch(/^\d{4}-\d{2}\.jsonl$/);
    expect(events(join(dir, '.factory', 'events', month ?? ''))[0]).toMatchObject({
      item: 0,
      station: 8,
      role: 'ops',
    });
  });

  it.each([
    ['no agent field', { agent_type: undefined }, /role/],
    ['an unknown role', { agent_type: 'owner' }, /role/],
    ['Define (no log target yet)', { agent_type: 'define' }, /define/],
    ['Intake (logs to issue comments)', { agent_type: 'intake' }, /intake/],
  ])('blocks and writes nothing for %s', async (_name, extra, why) => {
    const dir = workingCopy();
    const r = await hook('log', input(dir, extra));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(why);
    expect(existsSync(join(dir, FEATURE, 'events.jsonl'))).toBe(false);
    expect(existsSync(join(dir, '.factory', 'events'))).toBe(false);
  });

  it('blocks when .station.json names another role, or is missing', async () => {
    const other = workingCopy({ manifestRole: 'spec' });
    expect((await hook('log', input(other))).stderr).toMatch(/station\.json.*spec/);
    const none = workingCopy();
    writeFileSync(
      join(none, '.specify', 'feature.json'),
      JSON.stringify({ feature_directory: 'specs/9-x' }),
    );
    expect((await hook('log', input(none))).code).toBe(2);
  });

  it('blocks when the role file names a Fable model', async () => {
    const dir = workingCopy({ model: 'claude-fable-5-1' });
    const r = await hook('log', input(dir));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/model/);
  });

  it.each([
    [
      'feature_directory outside specs/',
      '.specify/feature.json',
      { feature_directory: '../x' },
      /feature_directory/,
    ],
    [
      'a manifest without an issue number',
      `${FEATURE}/.station.json`,
      { role: 'builder', item: 0, station: 4 },
      /item/,
    ],
    [
      'a manifest station out of range',
      `${FEATURE}/.station.json`,
      { role: 'builder', item: 42, station: 9 },
      /station/,
    ],
    [
      'a manifest that is not an object',
      `${FEATURE}/.station.json`,
      ['builder'],
      /not a JSON object/,
    ],
  ])('blocks on %s', async (_name, path, json, why) => {
    const dir = workingCopy();
    writeFileSync(join(dir, path), JSON.stringify(json));
    const r = await hook('log', input(dir));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(why);
  });

  it('blocks without a role file, a model in it, or a session id', async () => {
    const noFile = workingCopy();
    writeFileSync(join(noFile, '.claude', 'agents', 'builder.md'), '');
    expect((await hook('log', input(noFile))).stderr).toMatch(/no model/);
    expect((await hook('log', input(noFile, { agent_type: 'reviewer' }))).stderr).toMatch(
      /reviewer\.md not found/,
    );
    expect((await hook('log', input(workingCopy(), { session_id: '' }))).stderr).toMatch(
      /session_id/,
    );
  });
});

describe('factory hook entry: fail closed (contracts/hooks.md)', () => {
  it('unparseable stdin blocks', async () => {
    const r = await hook('log', '{not json');
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/hook input/);
    expect((await hook('log', '[]')).stderr).toMatch(/not a JSON object/);
  });

  it.each(['path-guard', 'read-guard', 'command-guard', 'session-start', 'pre-compact', 'nope'])(
    '%s is not in this build, so it blocks',
    async (event) => {
      const r = await hook(event, input(workingCopy()));
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/not available/);
    },
  );
});

describe('factory hook stop (AC-063)', () => {
  it('blocks a stop when no output checker exists for the station, and logs the block', async () => {
    const dir = workingCopy();
    const r = await hook('stop', input(dir, { hook_event_name: 'Stop', stop_hook_active: false }));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/no output checker for station 4/);
    expect(events(join(dir, FEATURE, 'events.jsonl'))[0]).toMatchObject({
      kind: 'blocked',
      tool: 'Stop',
      input_summary: expect.stringMatching(/no output checker/) as string,
    });
  });

  it('lets the session end when a checker passes, and keeps it going when it fails', async () => {
    const dir = workingCopy();
    const stopInput = input(dir, { hook_event_name: 'Stop', stop_hook_active: false });
    const pass: StationChecker = () => ({ complete: true });
    const fail: StationChecker = () => ({ complete: false, missing: ['plan.md'] });
    expect(await runStop(stopInput, { cwd: dir, now: () => new Date() }, { 4: pass })).toEqual({
      block: false,
    });
    expect(await runStop(stopInput, { cwd: dir, now: () => new Date() }, { 4: fail })).toEqual({
      block: true,
      reason: expect.stringContaining('plan.md') as string,
    });
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
