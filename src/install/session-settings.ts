// The `--settings` file of one session (T061, T082), which the local launcher writes into the
// session's folder under `~/.factory/sessions/<id>/`, where no session can read or write it, since
// an edit to the sandbox's lists applies to a running session. Every fresh clone is an untrusted
// folder, where Claude Code drops the project settings' allow list while their hooks still run
// (T125's A1), so this file carries every rule the session needs: the role's sandbox block and
// shell rules (src/install/sandbox.ts), its other tools and the factory MCP tools its role file
// names, `Edit(...)` rules for exactly the session's writable paths, which `dontAsk` needs and
// which make Claude Code's own permission layer enforce the role's write column beside the path
// guard, and the role's own deny list, the other MCP tools included. It also keeps out every
// `CLAUDE.md` a session would otherwise load from the folders above its clone, the Owner's own
// and any under `node_modules` (A5-2), and carries every key of the installed factory's own
// settings, its full hook set included, so nothing depends on the release a branch pins.
//
// Rule paths are absolute (`//<path>`): a `/<path>` rule is read from the settings file's own
// folder, which here is not the clone.
import { dirname } from 'node:path';
import { RefusedError } from '../cli/env.js';
import { deniedWrites, type Policy } from '../guard/policy.js';
import { isPlainPath } from '../model/naming.js';
import type { RoleName } from '../model/types.js';
import { isTestFile } from '../stations/edges.js';
import { renderSandbox, type SandboxSettings, type SessionPaths } from './sandbox.js';
import { deniedTools, MCP_TOOLS, type Settings } from './settings.js';

export type SessionSettings = Omit<Settings, 'permissions'> &
  Omit<SandboxSettings, 'permissions'> & {
    permissions: Settings['permissions'];
    claudeMdExcludes: string[];
  };

export interface SessionInput {
  role: RoleName;
  paths: SessionPaths;
  /** The item's feature folder, `specs/<issue>-<slug>`; empty for a role on a fixed branch. */
  feature: string;
  /** The task's files, or a conflict session's conflicted files. */
  files: readonly string[];
  /** The installed factory's own settings, never the release the branch pins. */
  factory: Settings;
  /** The factory MCP tools the role file names, as `mcp__factory__<tool>`. */
  mcp: readonly string[];
}

/** A table path as a rule's: home and any-depth paths as they are, others in the clone. */
const rulePath = (path: string, clone: string) =>
  path.startsWith('~/') || path.startsWith('**/') ? path : `/${clone}/${path}`;

/** The role's write column with the session's feature folder and files filled in. */
function writable(policy: Policy, { role, feature, files }: SessionInput): string[] {
  // The task's files come from tasks.md, which the Planner writes.
  const bad = files.find((file) => !isPlainPath(file));
  if (bad !== undefined)
    throw new RefusedError(`task file ${JSON.stringify(bad)} is not a plain path`);
  return policy.roles[role].write.flatMap((pattern) => {
    if (pattern === '{task}') return [...files];
    if (pattern === '{task:tests}') return files.filter((file) => isTestFile(file));
    if (pattern.includes('{feature}') && feature === '')
      throw new RefusedError(`${role} writes in a feature folder, and the session has none`);
    return [pattern.replaceAll('{feature}', feature)];
  });
}

/** `CLAUDE.md` and `CLAUDE.local.md` of every folder above the clone, up to `/`. */
function above(clone: string): string[] {
  const out: string[] = [];
  for (let dir = dirname(clone); ; dir = dirname(dir)) {
    const at = dir === '/' ? '' : dir;
    out.push(`${at}/CLAUDE.md`, `${at}/CLAUDE.local.md`);
    if (dir === '/') return out;
  }
}

export function renderSessionSettings(policy: Policy, input: SessionInput): SessionSettings {
  const { role, paths } = input;
  const { permissions: shell, ...sandbox } = renderSandbox(policy, role, paths);
  const own = policy.roles[role].tools.filter((t) => t !== 'Bash' && t !== 'Write' && t !== 'Edit');
  const factoryTools = MCP_TOOLS.map((name) => `mcp__factory__${name}`);
  const allow = [
    ...own,
    ...Object.keys(policy.keepTools),
    ...input.mcp,
    ...shell.allow,
    ...writable(policy, input).map((path) => `Edit(${rulePath(path, paths.clone)})`),
  ];
  const deny = [
    ...deniedTools(policy, role),
    // With --agent a session has only the MCP tools its role file names; denied as well.
    ...factoryTools.filter((tool) => !input.mcp.includes(tool)),
    ...deniedWrites(policy, role).map((path) => `Edit(${rulePath(path, paths.clone)})`),
    ...policy.denyRead.map((path) => `Read(${rulePath(path, paths.clone)})`),
    ...shell.deny,
    ...policy.denyShell.map((command) => `Bash(${command} *)`),
  ];
  // Every key of the factory's own settings, so nothing depends on the release the branch pins:
  // the rest win by precedence over the project's, and lists merge, which only adds.
  const { permissions: base, ...factory } = input.factory;
  const merged = (rules: string[], more: string[]) => [...new Set([...rules, ...more])];
  return {
    ...factory,
    ...sandbox,
    permissions: {
      allow: merged(base.allow, allow),
      deny: merged(base.deny, deny),
      blockReadsOutsideWorkingDirectories: true,
    },
    claudeMdExcludes: [
      ...above(paths.clone),
      `${paths.home}/.claude/CLAUDE.md`,
      `${paths.home}/.claude/CLAUDE.local.md`,
      `${paths.clone}/**/node_modules/**`,
    ],
  };
}
