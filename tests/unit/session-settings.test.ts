// The per-session `--settings` file (T061, T082): every rule a session needs, since in a fresh,
// untrusted clone Claude Code drops the project settings' allow list (T125's A1), with the role's
// own deny list, the `CLAUDE.md` files no session may load (A5-2) and the factory's full hooks.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadPolicy } from '../../src/guard/policy.js';
import { renderSessionSettings } from '../../src/install/session-settings.js';
import type { Settings } from '../../src/install/settings.js';
import { ROLES, type RoleName } from '../../src/model/types.js';

const policy = loadPolicy(
  readFileSync(new URL('../../factory/policy/roles.yaml', import.meta.url), 'utf8'),
);
const project = JSON.parse(
  readFileSync(new URL('../../factory/settings/settings.json', import.meta.url), 'utf8'),
) as Settings;

const HOME = '/home/o';
const CLONE = `${HOME}/factory-work/owner/project/42-add-login`;
const paths = { home: HOME, clone: CLONE, tmp: '/tmp/factory-42-a1b2c3', tools: [] };
const FEATURE = 'specs/42-add-login';
const FILES = ['src/login.ts', 'tests/login.test.ts'];

/** The factory MCP tools each role file names (factory/roles/<role>.md). */
const named = (role: RoleName) => {
  const file = readFileSync(new URL(`../../factory/roles/${role}.md`, import.meta.url), 'utf8');
  const tools = (/^tools: (.*)$/m.exec(file)?.[1] ?? '').split(', ');
  return tools.filter((tool) => tool.startsWith('mcp__factory__'));
};

const render = (role: RoleName, more: { feature?: string; files?: string[] } = {}) =>
  renderSessionSettings(policy, {
    role,
    paths,
    feature: more.feature ?? FEATURE,
    files: more.files ?? FILES,
    factory: project,
    mcp: named(role),
  });

describe('the per-session settings (T061, T082)', () => {
  it("carries the factory's full hook set, from the installed factory's own settings", () => {
    for (const role of ROLES) expect(render(role).hooks, role).toEqual(project.hooks);
    expect(project.hooks.PreToolUse[0]?.matcher).toBe('*');
  });

  it("carries every key of the installed factory's settings, its permissions merged with the role's", () => {
    for (const role of ROLES) {
      const settings = render(role) as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(project)) {
        if (key !== 'permissions') {
          expect(settings[key], `${role} ${key}`).toEqual(value);
          continue;
        }
        const { allow, deny } = render(role).permissions;
        expect(allow, role).toEqual(expect.arrayContaining(project.permissions.allow));
        expect(deny, role).toEqual(expect.arrayContaining(project.permissions.deny));
        expect(new Set(allow).size, role).toBe(allow.length);
        expect(new Set(deny).size, role).toBe(deny.length);
      }
    }
  });

  it('denies every factory MCP tool the role file does not name', () => {
    const mcp = (role: RoleName) => {
      const { deny } = render(role).permissions;
      return ['advance_item', 'log_event', 'request_split'].map((tool) => [
        tool,
        deny.includes(`mcp__factory__${tool}`) ? 'denied' : 'allowed',
      ]);
    };
    expect(mcp('reviewer')).toEqual([
      ['advance_item', 'denied'],
      ['log_event', 'denied'],
      ['request_split', 'allowed'],
    ]);
    expect(render('reviewer').permissions.allow).toContain('mcp__factory__request_split');
    expect(mcp('intake').map(([, verdict]) => verdict)).toEqual(['denied', 'denied', 'denied']);
  });

  it("allows each role's own tools and the factory's MCP tools, never relying on the project's allow list", () => {
    for (const role of ROLES) {
      const { allow } = render(role).permissions;
      for (const rule of project.permissions.allow) expect(allow, role).toContain(rule);
      for (const tool of ['ToolSearch', 'WaitForMcpServers']) expect(allow, role).toContain(tool);
      for (const tool of policy.roles[role].tools) {
        const covered =
          tool === 'Bash'
            ? allow.some((rule) => rule.startsWith('Bash('))
            : tool === 'Write' || tool === 'Edit'
              ? allow.some((rule) => rule.startsWith(`Edit(/${CLONE}/`))
              : allow.includes(tool);
        expect(covered, `${role} ${tool}`).toBe(true);
      }
    }
  });

  it("allows edits of exactly the session's writable paths, by absolute path in the clone", () => {
    const edits = (role: RoleName, more?: { feature?: string; files?: string[] }) =>
      render(role, more).permissions.allow.filter((rule) => rule.startsWith('Edit('));
    expect(edits('builder')).toEqual([
      `Edit(/${CLONE}/src/login.ts)`,
      `Edit(/${CLONE}/tests/login.test.ts)`,
    ]);
    expect(edits('test')).toEqual([`Edit(/${CLONE}/tests/login.test.ts)`]);
    expect(edits('spec')).toEqual([
      `Edit(/${CLONE}/${FEATURE}/spec.md)`,
      `Edit(/${CLONE}/${FEATURE}/checklists/requirements.md)`,
    ]);
    expect(edits('release', { feature: '', files: [] })).toEqual([
      `Edit(/${CLONE}/.factory/releases/**)`,
    ]);
    expect(edits('define', { feature: '', files: [] })).toEqual([`Edit(/${CLONE}/**)`]);
    expect(edits('intake', { feature: '', files: [] })).toEqual([]);
    expect(edits('builder', { files: [] })).toEqual([]);
  });

  it("refuses a task file that is no plain path in the clone, since tasks.md is the Planner's", () => {
    const shapes = ['**', 'src/*.ts', '/etc/passwd', '~/.bashrc', 'src/../../x', '..', '.', './'];
    shapes.push(...['src/', 'src/.', 'src//x.ts', './src/x.ts', 'src/a b.ts', 'src/a\nb.ts']);
    shapes.push(...['src/a).ts', 'src/a!.ts', 'src\\x.ts', 'src/#x.ts', '']);
    for (const file of shapes)
      expect(() => render('builder', { files: [file] }), file).toThrow(/is not a plain path/);
    const plain = ['src/login.ts', 'tests/a-b_c.test.ts', '@types/x.d.ts'];
    expect(() => render('builder', { files: plain })).not.toThrow();
  });

  it('refuses a feature folder for a role that writes in one when the session has none', () => {
    expect(() => render('spec', { feature: '' })).toThrow(/spec writes in a feature folder/);
  });

  it("denies a session every tool not its role's or kept: Task and Agent for all but the Builder", () => {
    const deny = (role: RoleName) => render(role).permissions.deny;
    expect(deny('reviewer')).toEqual(expect.arrayContaining(['Task', 'Agent']));
    expect(deny('builder')).not.toContain('Task');
    expect(deny('builder')).not.toContain('Agent');
    expect(deny('reviewer')).not.toContain('Read');
  });

  it('denies edits of the protected paths and reads of the secrets, the project settings’ denials kept', () => {
    const { deny } = render('builder').permissions;
    expect(deny).toEqual(
      expect.arrayContaining([
        `Edit(/${CLONE}/.claude/**)`,
        `Edit(/${CLONE}/.factory/config)`,
        'Edit(**/.station.json)',
        'Read(~/.factory/**)',
        'Read(**/.env*)',
        'Bash(git push *)',
      ]),
    );
    expect(render('builder').permissions.blockReadsOutsideWorkingDirectories).toBe(true);
  });

  it('keeps out every CLAUDE.md above the clone up to /, the Owner’s own and any under node_modules', () => {
    const above = [
      `${HOME}/factory-work/owner/project`,
      `${HOME}/factory-work/owner`,
      `${HOME}/factory-work`,
      HOME,
      '/home',
      '',
    ];
    expect(render('builder').claudeMdExcludes).toEqual([
      ...above.flatMap((dir) => [`${dir}/CLAUDE.md`, `${dir}/CLAUDE.local.md`]),
      `${HOME}/.claude/CLAUDE.md`,
      `${HOME}/.claude/CLAUDE.local.md`,
      `${CLONE}/**/node_modules/**`,
    ]);
  });

  it('opens for writing no folder under ~/.factory/, which the sandbox denies whole', () => {
    for (const role of ROLES) {
      const settings = render(role);
      const writable = [
        ...settings.sandbox.filesystem.allowWrite,
        ...settings.permissions.allow.filter((r) => r.startsWith('Edit(')),
      ];
      for (const path of writable) expect(path, role).not.toContain(`${HOME}/.factory`);
    }
    const inFactory = { ...paths, clone: `${HOME}/.factory/work/owner/project/42-add-login` };
    expect(() =>
      renderSessionSettings(policy, {
        ...{ role: 'builder', paths: inFactory, feature: FEATURE, files: FILES },
        ...{ factory: project, mcp: named('builder') },
      }),
    ).toThrow(/under the denied read ~\/\.factory/);
  });

  it('is the sandbox block for the role, beside its permissions', () => {
    const settings = render('builder');
    expect(settings.sandbox).toMatchObject({ enabled: true, allowUnsandboxedCommands: false });
    expect(settings.sandbox.filesystem.allowRead).toEqual([CLONE, paths.tmp]);
    expect(settings.sandbox.filesystem.allowWrite).toEqual([paths.tmp]);
  });
});
