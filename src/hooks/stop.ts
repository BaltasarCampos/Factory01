// `factory hook stop` (AC-063): a session may end only when its station's output exists and
// passes the station's completeness check. Checkers register here as their stations ship
// (Define in slice 12, T045; the others in slice 14, T057; Intake in slice 16b); a station
// without one fails closed (Owner decision, slice 7 note B).
//
// After one forced continuation (`stop_hook_active`) the session may end: the dispatcher reads
// the station output from the branch, so a session that stops early still advances nothing.
import { join } from 'node:path';
import { appendEvent } from '../events/append.js';
import { loadConfig } from '../model/config.js';
import { STATIONS, type Station } from '../model/types.js';
import { defineStopCheck } from '../stations/checks/define.js';
import { checkIntakeIssue } from '../stations/checks/intake.js';
import { planStopCheck } from '../stations/checks/plan.js';
import { specStopCheck } from '../stations/checks/spec.js';
import { verifyStopCheck } from '../stations/checks/verify.js';
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

/**
 * Intake has no `.station.json`: its item comes from the launcher's `FACTORY_ITEM` (slice 16b).
 * Without it the item is unknown and the stop is blocked. The hook cannot verify the Owner's
 * record, so it checks against tier 1 (no lowering check); the dispatcher checks the confirmed
 * tier before `new → triaged`.
 */
async function intakeStopCheck(session: Session, ctx: HookContext): Promise<CheckResult> {
  if (session.item === 0)
    return { complete: false, missing: ['no FACTORY_ITEM: the session does not know its item'] };
  const config = await loadConfig(join(ctx.cwd, '.factory', 'config'));
  return checkIntakeIssue(config.repo, session.item, 1);
}

/** Output checkers by station; a station without one fails closed. */
export const CHECKERS: Partial<Record<Station, StationChecker>> = {
  0: (_session, ctx) => defineStopCheck(ctx.cwd),
  1: intakeStopCheck,
  2: (_session, ctx) => specStopCheck(ctx.cwd),
  3: (_session, ctx) => planStopCheck(ctx.cwd),
  5: (_session, ctx) => verifyStopCheck(ctx.cwd),
};

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
