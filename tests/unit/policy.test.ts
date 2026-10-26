// The role permission table (T074, T081): `factory/policy/roles.yaml` transcribes the design's
// Tools and permissions table, the `branch` column of data-model.md § Role and the common
// denials, and `loadPolicy` reads it into typed rows, refusing anything it does not expect. The
// generated settings' copy of the critical denials is tested with the generator (25a-2).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deniedWrites, loadPolicy, matchesPath, type Policy } from '../../src/guard/policy.js';
import { ROLES, type RoleName } from '../../src/model/types.js';

const TABLE = fileURLToPath(new URL('../../factory/policy/roles.yaml', import.meta.url));
const text = readFileSync(TABLE, 'utf8');
const policy: Policy = loadPolicy(text);
const row = (role: RoleName) => policy.roles[role];
const F = '{feature}';

/** The `tools` line of the shipped role file. */
const roleFileTools = (role: RoleName) => {
  const file = readFileSync(new URL(`../../factory/roles/${role}.md`, import.meta.url), 'utf8');
  return (/^tools: (.*)$/m.exec(file)?.[1] ?? '').split(', ');
};

describe('the role permission table (T074, T081)', () => {
  it('has the twelve roles exactly, each with the tools of its role file', () => {
    expect(Object.keys(policy.roles).sort()).toEqual([...ROLES].sort());
    for (const role of ROLES) expect(row(role).tools, role).toEqual(roleFileTools(role));
  });

  it('gives each role the branch data-model.md § Role names', () => {
    const branches = Object.fromEntries(ROLES.map((r) => [r, row(r).branch]));
    expect(branches).toEqual({
      ...{ define: 'claude/define', intake: 'none', spec: 'item', planner: 'item' },
      ...{ builder: 'item', test: 'item', reviewer: 'item', security: 'item' },
      ...{ integrator: 'item', release: 'claude/factory-log', ops: 'claude/factory-log' },
      coach: 'claude/factory-log',
    });
  });

  it('limits each writing role to its own files, and Intake to none', () => {
    expect(row('intake').write).toEqual([]);
    expect(row('spec').write).toEqual([`${F}/spec.md`, `${F}/checklists/requirements.md`]);
    expect(row('planner').write).toEqual(
      ['plan.md', 'research.md', 'data-model.md', 'quickstart.md', 'contracts/**', 'tasks.md'].map(
        (p) => `${F}/${p}`,
      ),
    );
    expect(row('builder').write).toEqual(['{task}']);
    expect(row('test').write).toEqual(['{task:tests}']);
    // Each Verify and Integrate role writes only its own report; no row has reports/ as a folder.
    expect(row('reviewer').write).toEqual([`${F}/reports/verify.md`]);
    expect(row('security').write).toEqual([`${F}/reports/security.md`]);
    expect(row('integrator').write).toEqual([`${F}/reports/integrate.md`]);
    expect(row('release').write).toEqual(['.factory/releases/**']);
    expect(row('ops').write).toEqual(['.factory/ops/**']);
    expect(row('coach').write).toEqual(['.factory/lessons/**']);
  });

  it('gives each role with a shell only its prefixes, and a role without Bash none', () => {
    expect(row('intake').shell).toEqual(['gh issue']);
    for (const role of ['spec', 'planner'] as const) expect(row(role).shell, role).toEqual([]);
    // Builder's and Define's git and npm as explicit subcommands (T084).
    const git = ['git status', 'git diff', 'git log', 'git show', 'git add', 'git commit'];
    const npm = ['npm test', 'npm run', 'npm ci', 'npm install'];
    expect(row('define').shell).toEqual(
      [...npm, ...git, 'git restore', 'git rm', 'git mv'].concat([
        'git ls-files',
        'git grep',
        'gh issue',
      ]),
    );
    expect(row('builder').shell).toEqual(
      expect.arrayContaining([...npm, ...git, 'git merge origin/main', 'git merge --abort']),
    );
    for (const role of ['define', 'builder'] as const)
      expect(
        row(role).shell.filter((p) => !p.includes(' ')),
        role,
      ).toEqual(role === 'builder' ? ['vitest'] : []);
    expect(row('reviewer').shell).toEqual(['git diff', 'gh pr comment']);
    expect(row('security').shell).toEqual(['semgrep', 'gitleaks', 'npm audit']);
    expect(row('release').shell).toEqual(['git log', 'git show', 'git diff']);
    expect(row('coach').shell).toEqual(['gh pr view', 'gh pr list']);
    expect(row('integrator').shell).toEqual([
      ...['git merge origin/main', 'git merge --abort', 'git status', 'git diff --name-only'],
      ...['gh pr view', 'gh pr checks'],
    ]);
  });

  it('leaves git network and pull request changes to the factory: no shell pushes, fetches or opens one (T183)', () => {
    for (const role of ROLES)
      for (const command of ['git push', 'git fetch', 'gh pr create', 'gh pr ready'])
        expect(
          row(role).shell.some((s) => s.startsWith(command)),
          `${role}: ${command}`,
        ).toBe(false);
    expect(policy.denyShell).toEqual(
      expect.arrayContaining(['git push', 'gh pr create', 'gh pr ready']),
    );
  });

  it('blocks what the design always blocks: merges, approvals, rewrites, deploys and tags', () => {
    for (const role of ['reviewer', 'integrator'] as const)
      expect(row(role).blocked, role).toEqual(expect.arrayContaining(['gh pr review']));
    expect(row('integrator').blocked).toEqual(expect.arrayContaining(['git commit', 'git rebase']));
    for (const role of ['define', 'builder', 'integrator'] as const)
      expect(row(role).blocked, role).toEqual(
        expect.arrayContaining(['git rebase', 'git reset', 'git commit --amend']),
      );
    expect(row('release').blocked).toEqual(expect.arrayContaining(['gh release', 'git tag']));
    for (const command of ['gh pr merge', 'factory approve', 'factory merge', 'factory deploy'])
      expect(policy.denyShell).toContain(command);
    expect(policy.denyShell).toEqual(
      expect.arrayContaining(['factory resume', 'ssh-keygen -Y sign']),
    );
  });

  it('denies every role the guardrail paths, and only Define may write the brief', () => {
    const guardrails = [
      ...['.claude/**', '.mcp.json', '.github/workflows/**', '.factory/config', '.specify/**'],
      ...['.factory/lockfile-policy', '**/.gitattributes', '**/.gitmodules', '**/CLAUDE.md'],
      ...['**/CLAUDE.local.md', '**/.station.json', '**/events.jsonl', '.factory/events/**'],
    ];
    for (const role of ROLES) {
      expect(deniedWrites(policy, role), role).toEqual(expect.arrayContaining(guardrails));
      expect(deniedWrites(policy, role).includes('.factory/brief.md'), role).toBe(
        role !== 'define',
      );
    }
  });

  it('denies every role reading the approval key, credentials, git config, sessions and .env files (T183)', () => {
    expect(policy.denyRead).toEqual([
      ...['~/.factory/**', '~/.ssh/**', '~/.config/gh/**', '~/.git-credentials', '~/.netrc'],
      ...['~/.npmrc', '~/.gnupg/**', '~/.claude/.credentials.json', '~/.claude.json'],
      ...['~/.claude/projects/**', '~/.gitconfig', '~/.config/git/**', '**/.env*'],
    ]);
  });

  it('keeps open only the tools it names, each with a reason, and none a role already has', () => {
    expect(Object.keys(policy.keepTools)).toEqual([
      'ToolSearch',
      'EndConversation',
      'WaitForMcpServers',
    ]);
    for (const [tool, reason] of Object.entries(policy.keepTools)) {
      expect(reason.length, tool).toBeGreaterThan(10);
      for (const role of ROLES) expect(row(role).tools, role).not.toContain(tool);
    }
  });

  it('allows only the leading assignments it names, each with a reason (T084)', () => {
    expect(Object.keys(policy.assignments)).toEqual(['CI', 'NO_COLOR']);
    for (const [name, reason] of Object.entries(policy.assignments))
      expect(reason.length, name).toBeGreaterThan(10);
  });

  it('denies every role writing anything under .git/, at any depth (T183)', () => {
    const denied = (path: string) =>
      deniedWrites(policy, 'builder').some((p) => matchesPath(p, path));
    for (const path of ['.git/config', '.git/commondir', 'sub/.git', 'sub/.git/refs/replace/x'])
      expect(denied(path), path).toBe(true);
    for (const path of ['src/git.ts', '.gitignore', 'docs/.github-notes.md'])
      expect(denied(path), path).toBe(false);
    // The brief stays open to Define alone.
    expect(deniedWrites(policy, 'define').some((p) => matchesPath(p, '.factory/brief.md'))).toBe(
      false,
    );
  });
});

describe('loadPolicy refuses a table it does not expect (T082)', () => {
  const swap = (from: string, to: string) => {
    expect(text).toContain(from);
    return text.replace(from, to);
  };

  it.each([
    ['not YAML', ': [', /roles\.yaml: not YAML/],
    [
      'a role missing',
      swap('\n  coach:', '\n  coach-old:'),
      /roles\.yaml: roles: coach-old is not a role/,
    ],
    [
      'an unknown key',
      swap('    branch: none\n', '    branch: none\n    sudo: true\n'),
      /intake: unknown key sudo/,
    ],
    [
      'an unknown tool',
      swap('tools: [Read, Grep, Glob, Bash]', 'tools: [Read, Grep, Glob, Bash, WebFetch]'),
      /intake: unknown tool WebFetch/,
    ],
    [
      'a shell without Bash',
      swap('tools: [Read, Grep, Glob, Bash]', 'tools: [Read, Grep, Glob]'),
      /intake: a shell without Bash/,
    ],
    [
      'a write without Write or Edit',
      swap('    write: []\n', "    write: ['src/**']\n"),
      /intake: writes without Write or Edit/,
    ],
    [
      'an unknown branch',
      swap('    branch: none\n', '    branch: main\n'),
      /intake: branch main is not one of/,
    ],
    [
      'a kept tool with no reason',
      swap('  ToolSearch: ', "  ToolSearch: ''\n  WasToolSearch: "),
      /keep_tools: ToolSearch has no reason/,
    ],
    [
      'an assignment with no reason',
      swap('  CI: ', "  CI: ''\n  WasCI: "),
      /assignments: CI has no reason/,
    ],
    [
      'an assignment that is no variable name',
      swap('  CI: ', '  CI-X: '),
      /assignments: CI-X is not a variable name/,
    ],
    [
      'a shell naming a shell function of Claude Code (T081)',
      swap('shell: [gh issue]', 'shell: [gh issue, grep -r]'),
      /intake: shell names grep -r, a shell function of Claude Code's own/,
    ],
    [
      'a blank entry',
      swap('shell: [gh issue]', "shell: ['gh issue', ' ']"),
      /intake: shell has a blank or padded entry/,
    ],
  ])('refuses %s', (_name, table, error) => {
    expect(() => loadPolicy(table)).toThrow(error);
  });
});
