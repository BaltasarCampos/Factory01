// The session-start hook (T086, T078): `factory hook session-start` checks what needs no git, the
// session against its record (src/hooks/session.ts) and what launched it, and writes `passed.json`
// beside the record, which every guard requires (src/hooks/guards.ts). A SessionStart hook cannot
// end a session (T125's A7a–b), so a failed check removes the passed record instead: the session
// goes on, and every tool call it makes is refused. The check runs again when the hook fires after
// a compaction or a resume. The git-history checks run in the launcher before launch (slice 28-2b),
// the model, which the hook input does not carry, is checked from the stream's init message (slice
// 28-4), and the pause state, which lives on GitHub, at issue time by the dispatcher.
import { rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { visible } from '../notify/summary.js';
import type { HookContext, HookInput, HookResult } from './log.js';
import {
  logBlocked,
  passedPath,
  readSessionRecord,
  sessionId,
  type SessionRecord,
} from './session.js';

const shown = (value: unknown) => (value === undefined ? 'unset' : JSON.stringify(value));

/** The first fact that does not match the record, as its rule and why. */
function mismatch(r: SessionRecord, input: HookInput, env: NodeJS.ProcessEnv) {
  // The launcher sets no FACTORY_ITEM for a session with no item.
  const item = r.item > 0 ? String(r.item) : undefined;
  const { FACTORY_ROLE: role, FACTORY_ITEM: launched, FACTORY_STATION: station } = env;
  const checks: [string, boolean, string][] = [
    ['role', role === r.role, `FACTORY_ROLE ${shown(role)} is not the session's role ${r.role}`],
    [
      'item',
      launched === item,
      `FACTORY_ITEM ${shown(launched)} is not the session's item ${shown(item)}`,
    ],
    [
      'station',
      station === String(r.station),
      `FACTORY_STATION ${shown(station)} is not the session's station ${shown(String(r.station))}`,
    ],
    [
      'agent',
      input.agent_type === r.role,
      `agent_type ${shown(input.agent_type)} is not the session's role ${r.role}`,
    ],
    [
      'permission-mode',
      input.permission_mode === 'dontAsk',
      `permission_mode ${shown(input.permission_mode)} is not dontAsk`,
    ],
  ];
  return checks.find(([, ok]) => !ok);
}

export async function runSessionStart(input: HookInput, ctx: HookContext): Promise<HookResult> {
  const home = ctx.env?.HOME ?? homedir();
  const session = sessionId(input.session_id);
  const passed = passedPath(home, session);
  // Removed first, so a check that fails or throws leaves no passed record behind.
  rmSync(passed, { force: true });
  const record = readSessionRecord(home, session);
  const failed = mismatch(record, input, ctx.env ?? {});
  if (failed !== undefined) {
    const [rule, , why] = failed;
    const fields = { tool: 'SessionStart', input_summary: `${rule}: ${why}` };
    const unlogged = await logBlocked(record, home, session, fields, ctx.now);
    const reason = `refused: ${why}; no tool call of this session runs`;
    return { block: true, reason: visible(reason) + visible(unlogged) };
  }
  const source = typeof input.source === 'string' ? input.source : 'unknown';
  const checked = { session, source, checked_at: ctx.now().toISOString() };
  writeFileSync(passed, `${JSON.stringify(checked)}\n`);
  return { block: false };
}
