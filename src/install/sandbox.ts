// The sandbox settings for session shells (T183): one `--settings` file per role, which the local
// launcher passes to `claude -p` (slice 28), rendered from the role table. Passed with
// `--settings`, `allowUnsandboxedCommands: false` makes the sandbox admin-required, so the
// project's own `.claude/settings.json` cannot loosen it, and `failIfUnavailable` keeps Claude
// Code from starting without it. Checked against code.claude.com/docs/en/sandboxing and the
// settings reference for Claude Code 2.1.309, read 2026-10-23.
//
// Reads are default-no: all of home is denied and only the clone, the session's temporary folder
// and the tools' folders are opened again, the narrower path winning; the table's denied reads
// stay as a second layer, and a denied path inside an opened folder stays denied. Claude Code
// re-opens the global git config under `blockReadsOutsideWorkingDirectories`, which the table's
// `~/.gitconfig` entry overrides. On Linux the sandbox expands a read entry with a wildcard to
// the paths it matches when the session starts, so a `.env` file made later in the session is
// not covered; the file tools are covered by the project settings' `Read(...)` rules.
//
// Shell commands are not auto-allowed for running sandboxed: each role's shell column becomes
// allow rules and its blocked prefixes deny rules, so Claude Code's own matcher, which checks
// every part of a compound command, refuses what the command guard refuses if the guard fails.
import { RefusedError } from '../cli/env.js';
import type { Policy } from '../guard/policy.js';
import type { RoleName } from '../model/types.js';

/** Variables no sandboxed shell gets; roles without `gh` in their shell lose `GH_TOKEN` too. */
const CREDENTIALS = [
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'SSH_AUTH_SOCK',
];

/** Where the launcher runs a session: absolute paths, `tools` the folders its programs run from. */
export interface SessionPaths {
  home: string;
  clone: string;
  tmp: string;
  tools: string[];
}

export interface SandboxSettings {
  sandbox: {
    enabled: true;
    failIfUnavailable: true;
    allowUnsandboxedCommands: false;
    autoAllowBashIfSandboxed: false;
    excludedCommands: [];
    filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[] };
    network: { allowedDomains: string[]; strictAllowlist: true };
    credentials: { envVars: { name: string; mode: 'deny' }[] };
  };
  permissions: { allow: string[]; deny: string[] };
  syncClaudeAiSkills: false;
  syncClaudeAiPlugins: false;
}

/** A table read path in the sandbox's form: home paths as `~/<folder>`, others under the clone. */
const sandboxPath = (path: string, clone: string) =>
  path.startsWith('~/') ? path.replace(/\/\*\*$/, '') : `${clone}/${path}`;

const under = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/** Refuses an opened folder that would open home, or re-open a path the table denies. */
function checkOpened(policy: Policy, paths: SessionPaths, folders: string[]) {
  const home = paths.home.replace(/\/+$/, '');
  for (const raw of folders) {
    const folder = raw.replace(/\/+$/, '');
    if (!folder.startsWith('/')) throw new RefusedError(`${raw} is not an absolute path`);
    if (under(home, folder)) throw new RefusedError(`${raw} would open all of home`);
    for (const entry of policy.denyRead.map((path) => sandboxPath(path, paths.clone))) {
      const denied = entry.replace(/^~/, home);
      if (!/[*?[]/.test(denied) && under(folder, denied))
        throw new RefusedError(`${raw} is under the denied read ${entry}`);
    }
  }
}

/** The `--settings` file for a session of `role` working at `paths`. */
export function renderSandbox(
  policy: Policy,
  role: RoleName,
  paths: SessionPaths,
): SandboxSettings {
  const row = policy.roles[role];
  const opened = [paths.clone, paths.tmp, ...paths.tools];
  checkOpened(policy, paths, opened);
  const gh = row.shell.some((prefix) => prefix.startsWith('gh '));
  const denied = gh ? CREDENTIALS : ['GH_TOKEN', ...CREDENTIALS];
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      excludedCommands: [],
      filesystem: {
        denyRead: ['~/', ...policy.denyRead.map((path) => sandboxPath(path, paths.clone))],
        allowRead: opened,
        allowWrite: [paths.tmp],
      },
      network: { allowedDomains: row.network, strictAllowlist: true },
      credentials: { envVars: denied.map((name) => ({ name, mode: 'deny' })) },
    },
    permissions: {
      allow: row.shell.flatMap((prefix) => [`Bash(${prefix})`, `Bash(${prefix} *)`]),
      deny: row.blocked.map((prefix) => `Bash(${prefix} *)`),
    },
    syncClaudeAiSkills: false,
    syncClaudeAiPlugins: false,
  };
}
