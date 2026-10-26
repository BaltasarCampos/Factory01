// The guard hooks (T086): `factory hook path-guard` (Write, Edit), `read-guard` (Read, Grep, Glob)
// and `command-guard` (Bash) run the guards (T084, T085) on a tool call, with the session's facts
// from its record (src/hooks/session.ts) and the factory's own role table, never the clone's. A
// refusal blocks and appends a `blocked` event whose `input_summary` starts with the rule; a crash
// in a guard blocks too, its event naming an internal error, and never allows. An event that
// cannot be written still blocks, the reason saying why it was not written.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, type LogTarget } from '../events/append.js';
import { checkBash } from '../guard/command-guard.js';
import { checkWrite } from '../guard/path-guard.js';
import { loadPolicy, type Policy } from '../guard/policy.js';
import { checkRead } from '../guard/read-guard.js';
import { visible } from '../notify/summary.js';
import {
  roleIdentity,
  summarise,
  type HookContext,
  type HookInput,
  type HookResult,
} from './log.js';
import { readSessionRecord, type SessionRecord } from './session.js';

export type GuardKind = 'path-guard' | 'read-guard' | 'command-guard';
type Decision = { allowed: true } | { allowed: false; rule: string; reason: string };

const TOOLS: Record<GuardKind, string[]> = {
  'path-guard': ['Write', 'Edit'],
  'read-guard': ['Read', 'Grep', 'Glob'],
  'command-guard': ['Bash'],
};
const POLICY = new URL('../../factory/policy/roles.yaml', import.meta.url);
let policy: Policy | undefined;

/** Where the session's events go, as the log hook's fixed roles: Define and Intake have none. */
const logTarget = (r: SessionRecord): LogTarget | undefined =>
  r.role === 'define' || r.role === 'intake'
    ? undefined
    : r.feature === ''
      ? { factoryLog: r.clone }
      : { featureDir: join(r.clone, r.feature) };

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

function decide(kind: GuardKind, r: SessionRecord, input: HookInput, home: string): Decision {
  policy ??= loadPolicy(readFileSync(POLICY, 'utf8'));
  const tool = text(input.tool_name) ?? '';
  const given = input.tool_input;
  const t = (typeof given === 'object' && given !== null ? given : {}) as Record<string, unknown>;
  const cwd = text(input.cwd) ?? r.clone;
  const missing = (field: string): Decision => ({
    allowed: false,
    rule: 'input',
    reason: `refused: the ${tool} call has no ${field}`,
  });
  if (!TOOLS[kind].includes(tool))
    return { allowed: false, rule: 'tool', reason: `refused: ${kind} does not check ${tool}` };
  const places = { cwd, clone: r.clone, home };
  if (kind === 'command-guard') {
    const command = text(t.command);
    return command === undefined
      ? missing('command')
      : checkBash(policy, { role: r.role, command, cwd, home });
  }
  if (kind === 'path-guard') {
    const path = text(t.file_path);
    return path === undefined
      ? missing('file_path')
      : checkWrite(policy, { role: r.role, path, ...places, feature: r.feature, files: r.files });
  }
  const path = text(tool === 'Read' ? t.file_path : t.path);
  if (tool === 'Read' && path === undefined) return missing('file_path');
  const glob = text(t.glob);
  return checkRead(policy, {
    role: r.role,
    tool: tool as 'Read' | 'Grep' | 'Glob',
    ...places,
    ...(path === undefined ? {} : { path }),
    ...(glob === undefined ? {} : { glob }),
  });
}

/** Appends the `blocked` event; says why when it cannot. */
async function logBlocked(r: SessionRecord, input: HookInput, rule: string, ctx: HookContext) {
  const target = logTarget(r);
  if (target === undefined) return '';
  try {
    const identity = await roleIdentity(r.clone, r.role);
    const session = text(input.session_id) ?? '';
    const tool = text(input.tool_name) ?? 'unknown';
    const summary = `${rule}: ${summarise(input.tool_input)}`;
    const base = { item: r.item, station: r.station, role: r.role, session };
    const event = { ...base, role_version: identity.roleVersion, model: identity.model };
    await appendEvent(target, { ...event, kind: 'blocked', tool, input_summary: summary }, ctx.now);
    return '';
  } catch (error) {
    return ` (the blocked event was not written: ${error instanceof Error ? error.message : String(error)})`;
  }
}

export const guardHook =
  (kind: GuardKind) =>
  async (input: HookInput, ctx: HookContext): Promise<HookResult> => {
    const home = ctx.env?.HOME ?? homedir();
    const record = readSessionRecord(home, input.session_id);
    let decision: Decision;
    try {
      decision = decide(kind, record, input, home);
    } catch (error) {
      const why = visible(error instanceof Error ? error.message : String(error));
      decision = {
        allowed: false,
        rule: 'internal-error',
        reason: `refused: ${kind} failed: ${why}`,
      };
    }
    if (decision.allowed) return { block: false };
    const unlogged = await logBlocked(record, input, decision.rule, ctx);
    return { block: true, reason: decision.reason + visible(unlogged) };
  };
