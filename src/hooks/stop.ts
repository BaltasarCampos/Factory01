// `factory hook stop` (AC-063): a session may end only when its station's output exists and
// passes the station's completeness check. Checkers register here as their stations ship
// (slice 14: T045, T057); a station without one fails closed (Owner decision, slice 7 note B).
//
// After one forced continuation (`stop_hook_active`) the session may end: the dispatcher reads
// the station output from the branch, so a session that stops early still advances nothing.
import { appendEvent } from '../events/append.js';
import { STATIONS, type Station } from '../model/types.js';
import {
  eventInput,
  resolveSession,
  type HookContext,
  type HookInput,
  type HookResult,
  type Session,
} from './log.js';

export interface CheckResult {
  complete: boolean;
  /** What is missing or incomplete, for the session to fix. */
  missing?: string[];
}

export type StationChecker = (
  session: Session,
  ctx: HookContext,
) => CheckResult | Promise<CheckResult>;

/** Output checkers by station; empty until slice 14. */
export const CHECKERS: Partial<Record<Station, StationChecker>> = {};

export async function runStop(
  input: HookInput,
  ctx: HookContext,
  checkers: Partial<Record<Station, StationChecker>> = CHECKERS,
): Promise<HookResult> {
  if (input.stop_hook_active === true) return { block: false };
  const session = await resolveSession(input, ctx);
  const checker = checkers[session.station];
  const name = STATIONS[session.station];
  let reason: string | undefined;
  if (checker === undefined) {
    reason = `no output checker for station ${String(session.station)} (${name}) in this build; the session cannot confirm its output`;
  } else {
    const result = await checker(session, ctx);
    if (!result.complete) {
      reason = `station ${name} output is incomplete: ${(result.missing ?? ['see the station prompt']).join(', ')}`;
    }
  }
  if (reason === undefined) return { block: false };
  if (typeof session.log !== 'string') {
    const fields = { kind: 'blocked', tool: 'Stop', input_summary: reason } as const;
    await appendEvent(session.log, eventInput(session, fields), ctx.now);
  }
  return { block: true, reason };
}
