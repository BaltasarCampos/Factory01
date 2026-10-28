// The `--settings` file of one session (T061, T082), which the local launcher writes into the
// session's folder under `~/.factory/sessions/<id>/`, where no session can read or write it, since
// an edit to the sandbox's lists applies to a running session. Every fresh clone is an untrusted
// folder, where Claude Code drops the project settings' allow list while their hooks still run
// (T125's A1), so this file carries every rule the session needs: the role's sandbox block and
// shell rules (src/install/sandbox.ts), its other tools and the factory's MCP tools, `Edit(...)`
// rules for exactly the session's writable paths, which `dontAsk` needs and which make Claude
// Code's own permission layer enforce the role's write column beside the path guard, and the
// role's own deny list. It also keeps out every `CLAUDE.md` a session would otherwise load from
// the folders above its clone, the Owner's own and any under `node_modules` (A5-2), and carries
// the factory's full hook set, so a branch pinning an older release still runs the current hooks.
//
// Rule paths are absolute (`//<path>`): a `/<path>` rule is read from the settings file's own
// folder, which here is not the clone.
import { dirname } from 'node:path';
import { RefusedError } from '../cli/env.js';
import { deniedWrites, type Policy } from '../guard/policy.js';
import type { RoleName } from '../model/types.js';
import { isTestFile } from '../stations/edges.js';
import { renderSandbox, type SandboxSettings, type SessionPaths } from './sandbox.js';
import { deniedTools, MCP_TOOLS, type Settings } from './settings.js';

export interface SessionSettings extends Omit<SandboxSettings, 'permissions'> {
  permissions: { allow: string[]; deny: string[]; blockReadsOutsideWorkingDirectories: true };
  claudeMdExcludes: string[];
  hooks: Settings['hooks'];
}

export interface SessionInput {
  role: RoleName;
  paths: SessionPaths;
  /** The item's feature folder, `specs/<issue>-<slug>`; empty for a role on a fixed branch. */
  feature: string;
  /** The task's files, or a conflict session's conflicted files. */
  files: readonly string[];
  /** The factory's hooks, from the installed factory's own settings. */
  hooks: Settings['hooks'];
}

/** A table path as a rule's: home and any-depth paths as they are, others in the clone. */
const rulePath = (path: string, clone: string) =>
  path.startsWith('~/') || path.startsWith('**/') ? path : `/${clone}/${path}`;

/** A relative path in the clone with no `..` part and no character a rule reads as a pattern. */
const PLAIN = /^(?![/~])(?!(?:.*\/)?\.\.(?:\/|$))[^*?[\]{}]+$/;

/** The role's write column with the session's feature folder and files filled in. */
function writable(policy: Policy, { role, feature, files }: SessionInput): string[] {
  // The task's files come from tasks.md, which the Planner writes.
  const bad = files.find((file) => !PLAIN.test(file));
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
  const allow = [
    ...own,
    ...Object.keys(policy.keepTools),
    ...MCP_TOOLS.map((name) => `mcp__factory__${name}`),
    ...shell.allow,
    ...writable(policy, input).map((path) => `Edit(${rulePath(path, paths.clone)})`),
  ];
  const deny = [
    ...deniedTools(policy, role),
    ...deniedWrites(policy, role).map((path) => `Edit(${rulePath(path, paths.clone)})`),
    ...policy.denyRead.map((path) => `Read(${rulePath(path, paths.clone)})`),
    ...shell.deny,
    ...policy.denyShell.map((command) => `Bash(${command} *)`),
  ];
  return {
    ...sandbox,
    permissions: { allow, deny, blockReadsOutsideWorkingDirectories: true },
    claudeMdExcludes: [
      ...above(paths.clone),
      `${paths.home}/.claude/CLAUDE.md`,
      `${paths.home}/.claude/CLAUDE.local.md`,
      `${paths.clone}/**/node_modules/**`,
    ],
    hooks: input.hooks,
  };
}
