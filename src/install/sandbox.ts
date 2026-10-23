// The sandbox settings for session shells (T183): one `--settings` file per role, which the local
// launcher passes to `claude -p` (slice 28), rendered from the role table. Passed with
// `--settings`, `allowUnsandboxedCommands: false` makes the sandbox admin-required, so the
// project's own `.claude/settings.json` cannot loosen it, and `failIfUnavailable` keeps Claude
// Code from starting without it. Checked against code.claude.com/docs/en/sandboxing and the
// settings reference for Claude Code 2.1.309, read 2026-10-23.
//
// On Linux the sandbox expands a read entry with a wildcard to the paths it matches when the
// session starts, and skips a write entry with one, so a `.env` file made later in the session
// is not covered; the file tools are covered by the project settings' `Read(...)` rules.
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

export interface SandboxSettings {
  sandbox: {
    enabled: true;
    failIfUnavailable: true;
    allowUnsandboxedCommands: false;
    autoAllowBashIfSandboxed: true;
    excludedCommands: [];
    filesystem: { denyRead: string[] };
    network: { allowedDomains: string[]; strictAllowlist: true };
    credentials: { envVars: { name: string; mode: 'deny' }[] };
  };
  syncClaudeAiSkills: false;
  syncClaudeAiPlugins: false;
}

/** A table read path in the sandbox's form: home paths as `~/<folder>`, others under the clone. */
const sandboxPath = (path: string, clone: string) =>
  path.startsWith('~/') ? path.replace(/\/\*\*$/, '') : `${clone}/${path}`;

/** The `--settings` file for a session of `role` working in `clone`, an absolute path. */
export function renderSandbox(policy: Policy, role: RoleName, clone: string): SandboxSettings {
  const row = policy.roles[role];
  const gh = row.shell.some((prefix) => prefix.startsWith('gh '));
  const denied = gh ? CREDENTIALS : ['GH_TOKEN', ...CREDENTIALS];
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      excludedCommands: [],
      filesystem: { denyRead: policy.denyRead.map((path) => sandboxPath(path, clone)) },
      network: { allowedDomains: row.network, strictAllowlist: true },
      credentials: { envVars: denied.map((name) => ({ name, mode: 'deny' })) },
    },
    syncClaudeAiSkills: false,
    syncClaudeAiPlugins: false,
  };
}
