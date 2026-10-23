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
const CLONE = '/home/owner/factory-work/owner/project/42-add-login';
const sandbox = (role: (typeof ROLES)[number]) => renderSandbox(policy, role, CLONE);
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

  it('denies every role reading the table’s paths, the clone’s own under the clone', () => {
    const denyRead = sandbox('builder').sandbox.filesystem.denyRead;
    expect(denyRead).toEqual([
      ...['~/.factory', '~/.ssh', '~/.config/gh', '~/.git-credentials', '~/.netrc', '~/.npmrc'],
      ...['~/.gnupg', '~/.claude/.credentials.json', `${CLONE}/**/.env*`],
    ]);
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
