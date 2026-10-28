// The guard hooks (T086): `factory hook path-guard` (Write, Edit), `read-guard` (Read, Grep, Glob)
// and `command-guard` (Bash) run the guards (T084, T085) on a tool call, with the session's facts
// from its record (src/hooks/session.ts) and the factory's own role table, never the clone's. A
// refusal blocks and appends a `blocked` event whose `input_summary` starts with the rule; a crash
// in a guard blocks too, its event naming an internal error, and never allows. An event that
// cannot be written still blocks, the reason saying why it was not written. Every call is refused
// until the session-start hook has passed the session (src/hooks/session-start.ts), and every call
// out of `dontAsk`, so a mode changed during the session is refused too. The hooks run outside
// the sandbox, so they read nothing from the clone but the paths the guards resolve, and write
// their events to the session's own log under `~/.factory/`, never into the clone. `factory hook
// gate`, on every tool (matcher `*`), runs only those two checks, so a tool no guard checks, such
// as a subagent, an MCP tool or one a later Claude Code adds, is refused before the start too.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { checkBash } from '../guard/command-guard.js';
import { checkWrite } from '../guard/path-guard.js';
import { loadPolicy, type Policy } from '../guard/policy.js';
import { checkRead } from '../guard/read-guard.js';
import { visible } from '../notify/summary.js';
import { summarise, type HookContext, type HookInput, type HookResult } from './log.js';
import {
  logBlocked,
  passedPath,
  readSessionRecord,
  sessionId,
  type SessionRecord,
} from './session.js';

export type GuardKind = 'path-guard' | 'read-guard' | 'command-guard';
type Check = (r: SessionRecord, input: HookInput, home: string) => Decision;
type Decision = { allowed: true } | { allowed: false; rule: string; reason: string };

const TOOLS: Record<GuardKind, string[]> = {
  'path-guard': ['Write', 'Edit'],
  'read-guard': ['Read', 'Grep', 'Glob'],
  'command-guard': ['Bash'],
};
const POLICY = new URL('../../factory/policy/roles.yaml', import.meta.url);
let policy: Policy | undefined;

/** The tool-input fields the guards read; one present but not a string blocks. */
const FIELDS = ['command', 'file_path', 'path', 'glob', 'pattern'];

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
const refuse = (rule: string, why: string): Decision => ({
  allowed: false,
  rule,
  reason: visible(`refused: ${why}`),
});

/** Refuses a session the session-start hook has not passed, or a call out of `dontAsk`. */
function started(home: string, session: string, input: HookInput): Decision | undefined {
  let passed: unknown;
  try {
    const path = passedPath(home, session);
    passed = (JSON.parse(readFileSync(path, 'utf8')) as { session?: unknown }).session;
  } catch {
    passed = undefined;
  }
  if (passed !== session)
    return refuse(
      'session-start',
      'the session-start check has not passed for this session; no tool call runs',
    );
  const mode = input.permission_mode;
  if (mode !== 'dontAsk')
    return refuse(
      'permission-mode',
      `permission_mode ${mode === undefined ? 'unset' : JSON.stringify(mode)} is not dontAsk; no tool call runs`,
    );
  return undefined;
}

function decide(kind: GuardKind, r: SessionRecord, input: HookInput, home: string): Decision {
  policy ??= loadPolicy(readFileSync(POLICY, 'utf8'));
  const tool = text(input.tool_name) ?? '';
  const given = input.tool_input;
  const t = (typeof given === 'object' && given !== null ? given : {}) as Record<string, unknown>;
  const cwd = text(input.cwd) ?? r.clone;
  const missing = (field: string) => refuse('input', `the ${tool} call has no ${field}`);
  if (!TOOLS[kind].includes(tool)) return refuse('tool', `${kind} does not check ${tool}`);
  const odd = FIELDS.find((field) => t[field] !== undefined && typeof t[field] !== 'string');
  if (odd !== undefined) return refuse('input', `the ${tool} call's ${odd} is not a string`);
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
  const pattern = text(t.pattern);
  if (tool === 'Glob' && pattern === undefined) return missing('pattern');
  return checkRead(policy, {
    role: r.role,
    tool: tool as 'Read' | 'Grep' | 'Glob',
    ...places,
    ...(path === undefined ? {} : { path }),
    ...(glob === undefined ? {} : { glob }),
    ...(tool === 'Glob' && pattern !== undefined ? { pattern } : {}),
  });
}

const checked =
  (name: string, check: Check) =>
  async (input: HookInput, ctx: HookContext): Promise<HookResult> => {
    const home = ctx.env?.HOME ?? homedir();
    const session = sessionId(input.session_id);
    const record = readSessionRecord(home, session);
    let decision: Decision;
    try {
      decision = started(home, session, input) ?? check(record, input, home);
    } catch (error) {
      const why = visible(error instanceof Error ? error.message : String(error));
      decision = {
        allowed: false,
        rule: 'internal-error',
        reason: `refused: ${name} failed: ${why}`,
      };
    }
    if (decision.allowed) return { block: false };
    const fields = {
      tool: text(input.tool_name) ?? 'unknown',
      input_summary: `${decision.rule}: ${summarise(input.tool_input)}`,
    };
    const unlogged = await logBlocked(record, home, session, fields, ctx.now);
    return { block: true, reason: decision.reason + visible(unlogged) };
  };

export const guardHook = (kind: GuardKind) =>
  checked(kind, (r, input, home) => decide(kind, r, input, home));

/** Every tool call: only the session-start and `dontAsk` checks. */
export const gateHook = checked('gate', () => ({ allowed: true }));
