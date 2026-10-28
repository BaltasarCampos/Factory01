// The role policy (T082's loader): `factory/policy/roles.yaml` read into typed rows, one per role.
// The settings generator (T082) and the guards (T084, T085) read these rows; the table is their
// one source. Anything the loader does not expect refuses, so a typo can never quietly widen a
// role: an unknown key, tool or branch, a role missing or added, a shell without Bash, a write
// without Write or Edit, or a blank entry.
import { parse } from 'yaml';
import { RefusedError } from '../cli/env.js';
import { ROLES, type RoleName } from '../model/types.js';

/** Claude Code's own tools that a role may be given; `Task` is 2.1.309's name for `Agent`. */
export const TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent', 'Task'] as const;
export const BRANCHES = ['item', 'claude/factory-log', 'claude/define', 'none'] as const;

export interface RolePolicy {
  tools: (typeof TOOLS)[number][];
  /** Paths the role may Write or Edit; `{feature}`, `{task}` and `{task:tests}` as in the table. */
  write: string[];
  /** Command prefixes, as words, that the role's shell may run. */
  shell: string[];
  /** Command prefixes always refused for the role, on top of `denyShell`. */
  blocked: string[];
  /** The hosts the role's sandboxed shell may reach (T183). */
  network: string[];
  branch: (typeof BRANCHES)[number];
}

export interface Policy {
  roles: Record<RoleName, RolePolicy>;
  /** Paths no role writes, each open only to the roles in `except`. */
  denyWrite: { path: string; except: RoleName[] }[];
  denyRead: string[];
  denyShell: string[];
  /** Claude Code tools open to every session besides each role's own, each with its reason. */
  keepTools: Record<string, string>;
  /** Names a command may assign before its program, each with its reason (T084). */
  assignments: Record<string, string>;
}

const ROW_KEYS = ['tools', 'write', 'shell', 'blocked', 'network', 'branch'];
/** Names Claude Code defines as shell functions of its own in some sessions (T081). */
const CLAUDE_FUNCTIONS = ['find', 'grep', 'rg', 'pkill'];
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const TOP_KEYS = ['roles', 'deny_write', 'deny_read', 'deny_shell', 'keep_tools', 'assignments'];

const refuse = (why: string) => new RefusedError(`roles.yaml: ${why}`);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function keysOf(value: unknown, keys: readonly string[], where: string) {
  if (!isObject(value)) throw refuse(`${where} is not a mapping`);
  for (const key of Object.keys(value))
    if (!keys.includes(key)) throw refuse(`${where}: unknown key ${key}`);
  for (const key of keys) if (!(key in value)) throw refuse(`${where}: no ${key}`);
  return value;
}

/** A list of non-blank strings with no padding. */
function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw refuse(`${where} is not a list`);
  for (const item of value)
    if (typeof item !== 'string' || item.trim() === '' || item !== item.trim())
      throw refuse(`${where} has a blank or padded entry`);
  return value as string[];
}

function rolePolicy(role: RoleName, value: unknown): RolePolicy {
  const row = keysOf(value, ROW_KEYS, role);
  const tools = strings(row.tools, `${role}: tools`);
  for (const tool of tools)
    if (!(TOOLS as readonly string[]).includes(tool)) throw refuse(`${role}: unknown tool ${tool}`);
  const write = strings(row.write, `${role}: write`);
  const shell = strings(row.shell, `${role}: shell`);
  const shadowed = shell.find((prefix) => CLAUDE_FUNCTIONS.includes(prefix.split(' ')[0] ?? ''));
  if (shadowed !== undefined)
    throw refuse(`${role}: shell names ${shadowed}, a shell function of Claude Code's own`);
  if (write.length > 0 && !tools.includes('Write') && !tools.includes('Edit'))
    throw refuse(`${role}: writes without Write or Edit`);
  if (shell.length > 0 !== tools.includes('Bash'))
    throw refuse(
      shell.length > 0 ? `${role}: a shell without Bash` : `${role}: Bash with no shell`,
    );
  const network = strings(row.network, `${role}: network`);
  if (network.length > 0 && !tools.includes('Bash'))
    throw refuse(`${role}: a network without Bash`);
  if (network.some((host) => !HOST.test(host)))
    throw refuse(`${role}: network has a host that is not a plain name`);
  const branch = row.branch;
  if (typeof branch !== 'string' || !(BRANCHES as readonly string[]).includes(branch))
    throw refuse(`${role}: branch ${String(branch)} is not one of ${BRANCHES.join(', ')}`);
  return {
    ...{ tools: tools as RolePolicy['tools'], write, shell },
    blocked: strings(row.blocked, `${role}: blocked`),
    network,
    branch: branch as RolePolicy['branch'],
  };
}

function denyWrite(value: unknown): Policy['denyWrite'] {
  if (!Array.isArray(value)) throw refuse('deny_write is not a list');
  return value.map((entry) => {
    if (typeof entry === 'string')
      return { path: strings([entry], 'deny_write')[0] ?? '', except: [] };
    const { path, except } = keysOf(entry, ['path', 'except'], 'deny_write');
    const roles = strings(except, `deny_write: ${String(path)}: except`);
    for (const role of roles)
      if (!(ROLES as readonly string[]).includes(role))
        throw refuse(`deny_write: ${role} is not a role`);
    return { path: strings([path], 'deny_write')[0] ?? '', except: roles as RoleName[] };
  });
}

export function loadPolicy(text: string): Policy {
  let data: unknown;
  try {
    data = parse(text);
  } catch {
    throw refuse('not YAML');
  }
  const top = keysOf(data, TOP_KEYS, 'the table');
  if (!isObject(top.roles)) throw refuse('roles is not a mapping');
  for (const role of Object.keys(top.roles))
    if (!(ROLES as readonly string[]).includes(role)) throw refuse(`roles: ${role} is not a role`);
  const roles = Object.fromEntries(
    ROLES.map((role) => [role, rolePolicy(role, (top.roles as Record<string, unknown>)[role])]),
  ) as Record<RoleName, RolePolicy>;
  return {
    roles,
    denyWrite: denyWrite(top.deny_write),
    denyRead: strings(top.deny_read, 'deny_read'),
    denyShell: strings(top.deny_shell, 'deny_shell'),
    keepTools: reasons(top.keep_tools, 'keep_tools'),
    assignments: reasons(top.assignments, 'assignments'),
  };
}

/** A mapping of names to reasons; an assignment's name must be a shell variable's. */
function reasons(value: unknown, where: string): Record<string, string> {
  if (!isObject(value)) throw refuse(`${where} is not a mapping`);
  for (const [name, reason] of Object.entries(value)) {
    if (typeof reason !== 'string' || reason.trim() === '')
      throw refuse(`${where}: ${name} has no reason`);
    if (where === 'assignments' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw refuse(`assignments: ${name} is not a variable name`);
  }
  return value as Record<string, string>;
}

/**
 * Whether a table path matches `path`, relative to the clone: `**` spans folders, `*` stays in
 * one, and a pattern starting `**` + `/` matches at any depth, as gitignore does.
 */
export function matchesPath(pattern: string, path: string): boolean {
  const source = pattern
    .split(/(\*\*\/|\/\*\*|\*\*|\*)/)
    .map((part) => {
      if (part === '**/') return '(?:.*/)?';
      if (part === '/**') return '(?:/.*)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}$`).test(path);
}

/** The paths `role` may never Write or Edit. */
export const deniedWrites = (policy: Policy, role: RoleName) =>
  policy.denyWrite.filter((d) => !d.except.includes(role)).map((d) => d.path);
