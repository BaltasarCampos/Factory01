// `factory hook <event>` (contracts/hooks.md): reads the Claude Code hook JSON on stdin.
// Exit 0 allows, exit 2 blocks with the reason on stderr. Every failure blocks (fail closed),
// including hooks this build does not have yet.
import type { CommandContext } from '../cli/commands.js';
import { gateHook, guardHook } from '../hooks/guards.js';
import { runLog, type HookContext, type HookInput, type HookResult } from '../hooks/log.js';
import { runPostEdit } from '../hooks/post-edit.js';
import { runPreCompact } from '../hooks/pre-compact.js';
import { runSessionStart } from '../hooks/session-start.js';
import { runStop } from '../hooks/stop.js';
import { visible } from '../notify/summary.js';

const ALLOW = 0;
const BLOCK = 2;

const HOOKS: Readonly<Record<string, (input: HookInput, ctx: HookContext) => Promise<HookResult>>> =
  {
    log: runLog,
    'post-edit': runPostEdit,
    stop: (input, ctx) => runStop(input, ctx),
    'path-guard': guardHook('path-guard'),
    'read-guard': guardHook('read-guard'),
    'command-guard': guardHook('command-guard'),
    'session-start': runSessionStart,
    'pre-compact': runPreCompact,
    gate: gateHook,
  };

/** The hooks this build serves; a release's settings naming another are refused (T061). */
export const SERVED_HOOKS: readonly string[] = Object.keys(HOOKS);

export async function hook(ctx: CommandContext): Promise<number> {
  const event = ctx.positionals[0] ?? '';
  const block = (reason: string) => {
    ctx.io.stderr.write(`factory hook ${event}: ${reason}\n`);
    return BLOCK;
  };
  try {
    const run = Object.hasOwn(HOOKS, event) ? HOOKS[event] : undefined;
    if (run === undefined) return block('not available in this build');
    let input: unknown;
    try {
      input = JSON.parse(await ctx.readStdin());
    } catch {
      return block('could not parse the hook input JSON on stdin');
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return block('the hook input is not a JSON object');
    }
    const fields = input as HookInput;
    const cwd = typeof fields.cwd === 'string' ? fields.cwd : ctx.cwd;
    const result = await run(fields, { cwd, now: () => new Date(), env: ctx.env });
    return result.block ? block(result.reason ?? 'blocked') : ALLOW;
  } catch (err) {
    // Such as a record path under HOME: the text can hold anything a path can.
    return block(visible(err instanceof Error ? err.message : String(err)));
  }
}
