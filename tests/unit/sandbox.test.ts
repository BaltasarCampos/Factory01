// The sandbox settings for session shells (T183): one `--settings` file per role, which the local
// launcher passes to `claude -p`, rendered from the role table, failing closed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPolicy } from '../../src/guard/policy.js';
import { renderSandbox } from '../../src/install/sandbox.js';
import { ROLES } from '../../src/model/types.js';

const text = readFileSync(
  fileURLToPath(new URL('../../factory/policy/roles.yaml', import.meta.url)),
  'utf8',
);
const policy = loadPolicy(text);
const HOME = '/home/owner';
const CLONE = `${HOME}/factory-work/owner/project/42-add-login`;
const TMP = '/tmp/factory-42-x1y2';
const NODE = `${HOME}/.config/nvm/versions/node/v24.14.1`;
const session = { home: HOME, clone: CLONE, tmp: TMP, tools: [NODE] };
const sandbox = (role: (typeof ROLES)[number]) => renderSandbox(policy, role, session);
const usesGh = (role: (typeof ROLES)[number]) =>
  policy.roles[role].shell.some((s) => s.startsWith('gh '));

describe('the sandbox settings for session shells (T183)', () => {
  it.each(ROLES)(
    '%s: the sandbox fails closed, with no way out and no host off its list',
    (role) => {
      expect(sandbox(role).sandbox).toMatchObject({
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        excludedCommands: [],
        network: { strictAllowlist: true },
      });
    },
  );

  it('denies all of home, opening only the clone, the session’s temporary folder and the tools’ folders', () => {
    const { denyRead, allowRead, allowWrite } = sandbox('builder').sandbox.filesystem;
    expect(denyRead.slice(0, 4)).toEqual(['~/', '/tmp', '/var/tmp', '/dev/shm']);
    expect(allowRead).toEqual([CLONE, TMP, NODE]);
    // The npm cache lives in the temporary folder.
    expect(allowWrite).toEqual([TMP]);
  });

  it('keeps the table’s denied reads as a second layer, the clone’s own under the clone', () => {
    const denyRead = sandbox('builder').sandbox.filesystem.denyRead;
    expect(denyRead.slice(4)).toEqual([
      ...['~/.factory', '~/.ssh', '~/.config/gh', '~/.git-credentials', '~/.netrc', '~/.npmrc'],
      ...['~/.gnupg', '~/.claude/.credentials.json', '~/.claude.json', '~/.claude/projects'],
      ...['~/.gitconfig', '~/.config/git', `${CLONE}/**/.env*`],
    ]);
  });

  it('refuses to open home itself, a relative folder, or one at or under a denied read', () => {
    const open = (tools: string[]) => () => renderSandbox(policy, 'builder', { ...session, tools });
    expect(open([HOME])).toThrow(/would open all of home/);
    expect(open([`${HOME}/`])).toThrow(/would open all of home/);
    expect(open(['/home'])).toThrow(/would open all of home/);
    expect(open(['node/bin'])).toThrow(/node\/bin is not an absolute path/);
    expect(open([`${HOME}/.factory/bin`])).toThrow(
      /\.factory\/bin is under the denied read ~\/\.factory/,
    );
    expect(open([`${HOME}/.ssh`])).toThrow(/is under the denied read ~\/\.ssh/);
    expect(() =>
      renderSandbox(policy, 'builder', { ...session, clone: `${HOME}/.factory/work/x` }),
    ).toThrow(/is under the denied read ~\/\.factory/);
  });

  it('refuses the shared temporary folders themselves, and a clone or tool folder in one', () => {
    const at = (change: Partial<typeof session>) => () =>
      renderSandbox(policy, 'builder', { ...session, ...change });
    expect(at({ tmp: '/tmp' })).toThrow(/\/tmp would open all of \/tmp/);
    expect(at({ tmp: '/dev/shm/' })).toThrow(/would open all of \/dev\/shm/);
    expect(at({ clone: '/tmp/42-add-login' })).toThrow(
      /\/tmp\/42-add-login is under the shared temporary folder \/tmp/,
    );
    expect(at({ tools: ['/var/tmp/node'] })).toThrow(
      /under the shared temporary folder \/var\/tmp/,
    );
    expect(at({ tmp: '/var/tmp/factory-42' })).not.toThrow();
  });

  it('runs only the role’s shell column, through Claude Code’s own matcher, not every sandboxed command', () => {
    for (const role of ROLES) {
      const row = policy.roles[role];
      const { sandbox: box, permissions } = sandbox(role);
      expect(box.autoAllowBashIfSandboxed, role).toBe(false);
      expect(permissions.allow, role).toEqual(
        row.shell.flatMap((prefix) => [`Bash(${prefix})`, `Bash(${prefix} *)`]),
      );
      expect(permissions.deny, role).toEqual(row.blocked.map((prefix) => `Bash(${prefix} *)`));
    }
    expect(sandbox('reviewer').permissions.allow).toContain('Bash(gh pr comment *)');
    expect(sandbox('reviewer').permissions.allow).not.toContain('Bash(gh api *)');
    expect(sandbox('spec').permissions).toEqual({ allow: [], deny: [] });
  });

  it('lets a shell reach only the hosts its role needs', () => {
    const hosts = Object.fromEntries(
      ROLES.map((r) => [r, sandbox(r).sandbox.network.allowedDomains]),
    );
    for (const role of ROLES)
      expect(hosts[role]?.includes('api.github.com'), role).toBe(usesGh(role));
    expect(hosts.builder).toEqual(['registry.npmjs.org']);
    expect(hosts.spec).toEqual([]);
    expect(hosts.release).toEqual([]);
  });

  it('gives the comment-only gh token only to roles with gh in their shell, and no other credential', () => {
    for (const role of ROLES) {
      const denied = sandbox(role).sandbox.credentials.envVars.map((v) => v.name);
      expect(denied, role).toEqual(
        expect.arrayContaining(['GITHUB_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'SSH_AUTH_SOCK']),
      );
      expect(denied.includes('GH_TOKEN'), role).toBe(!usesGh(role));
    }
  });

  it('keeps the skills and plugins of the Owner’s claude.ai account out', () => {
    expect(sandbox('builder')).toMatchObject({
      syncClaudeAiSkills: false,
      syncClaudeAiPlugins: false,
    });
  });

  it('refuses a network for a role with no shell, and a host that is not a plain name', () => {
    const swap = (from: string, to: string) => {
      expect(text).toContain(from);
      return loadPolicy(text.replace(from, to));
    };
    expect(() =>
      swap('    network: []\n    branch: item', '    network: [example.com]\n    branch: item'),
    ).toThrow(/spec: a network without Bash/);
    expect(() => swap('network: [registry.npmjs.org]', 'network: ["*.npmjs.org"]')).toThrow(
      /builder: network has a host that is not a plain name/,
    );
  });
});
