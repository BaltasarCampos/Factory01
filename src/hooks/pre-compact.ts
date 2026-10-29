// `factory hook pre-compact` (contracts/hooks.md), at its least until T099: it blocks the
// compaction, appends a `blocked` event with its reason to the session's own log, and tells the
// session to stop, since a full context means the task is too big for one session. T099 adds the
// full logging and the split request.
import { homedir } from 'node:os';
import { visible } from '../notify/summary.js';
import type { HookContext, HookInput, HookResult } from './log.js';
import { logBlocked, readSessionRecord, sessionId } from './session.js';

const REASON = 'stop: your context is full, so the task is too big for one session';

export async function runPreCompact(input: HookInput, ctx: HookContext): Promise<HookResult> {
  const home = ctx.env?.HOME ?? homedir();
  const session = sessionId(input.session_id);
  const record = readSessionRecord(home, session);
  const fields = { tool: 'PreCompact', input_summary: `pre-compact: ${REASON}` };
  const unlogged = await logBlocked(record, home, session, fields, ctx.now);
  return { block: true, reason: REASON + visible(unlogged) };
}
