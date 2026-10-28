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

const render = (role: RoleName, more: { feature?: string; files?: string[] } = {}) =>
  renderSessionSettings(policy, {
    role,
    paths,
    feature: more.feature ?? FEATURE,
    files: more.files ?? FILES,
    hooks: project.hooks,
  });

describe('the per-session settings (T061, T082)', () => {
  it("carries the factory's full hook set, from the installed factory's own settings", () => {
    for (const role of ROLES) expect(render(role).hooks, role).toEqual(project.hooks);
    expect(project.hooks.PreToolUse[0]?.matcher).toBe('*');
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
        hooks: project.hooks,
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
