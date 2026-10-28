// `factory hook stop` (AC-063): a session may end only when its station's output exists and
// passes the station's completeness check. Checkers register here as their stations ship
// (Define in slice 12, T045; the others in slice 14, T057; Intake in slice 16b; Build in slice
// 26e-1, T174); a station without one fails closed (Owner decision, slice 7 note B).
//
// After one forced continuation (`stop_hook_active`) the session may end: the dispatcher reads
// the station output from the branch, so a session that stops early still advances nothing.
//
// The role, station, item, clone and repository come from the session's record
// (src/hooks/session.ts), never from the clone, and a blocked stop is logged in the session's own
// log, Define's and Intake's included.
import { homedir } from 'node:os';
import { STATIONS, type Station } from '../model/types.js';
import { visible } from '../notify/summary.js';
import { buildStopCheck } from '../stations/checks/build.js';
import { defineStopCheck } from '../stations/checks/define.js';
import { checkIntakeIssue } from '../stations/checks/intake.js';
import { planStopCheck } from '../stations/checks/plan.js';
import { securityStopCheck } from '../stations/checks/security.js';
import { specStopCheck } from '../stations/checks/spec.js';
import { verifyStopCheck } from '../stations/checks/verify.js';
import type { HookContext, HookInput, HookResult } from './log.js';
import { logBlocked, readSessionRecord, sessionId, type SessionRecord } from './session.js';

export interface CheckResult {
  complete: boolean;
  /** What is missing or incomplete, for the session to fix. */
  missing?: string[];
  /** Only the Owner's answers are missing: a valid stop, waiting for them (T180). */
  waiting?: boolean;
}

export type StationChecker = (r: SessionRecord) => CheckResult | Promise<CheckResult>;

/**
 * Intake checks its item's labels in the record's repository; a record with no item blocks the
 * stop. The hook cannot verify the Owner's record, so it checks against tier 1 (no lowering
 * check); the dispatcher checks the confirmed tier before `new → triaged`.
 */
function intakeStopCheck(r: SessionRecord): CheckResult | Promise<CheckResult> {
  if (r.item === 0) return { complete: false, missing: ["the session's record names no item"] };
  return checkIntakeIssue(r.repo, r.item, 1);
}

/**
 * Output checkers by station, each reading the record's clone; a station without one fails
 * closed. Verify has two outputs, so the record's role picks Security's report or the review
 * (T168).
 */
export const CHECKERS: Partial<Record<Station, StationChecker>> = {
  0: (r) => defineStopCheck(r.clone),
  1: intakeStopCheck,
  2: (r) => specStopCheck(r.clone),
  3: (r) => planStopCheck(r.clone),
  4: (r) => buildStopCheck(r.clone),
  5: (r) => (r.role === 'security' ? securityStopCheck(r.clone) : verifyStopCheck(r.clone)),
};

export async function runStop(
  input: HookInput,
  ctx: HookContext,
  checkers: Partial<Record<Station, StationChecker>> = CHECKERS,
): Promise<HookResult> {
  if (input.stop_hook_active === true) return { block: false };
  const home = ctx.env?.HOME ?? homedir();
  const session = sessionId(input.session_id);
  const record = readSessionRecord(home, session);
  const checker = checkers[record.station];
  const name = STATIONS[record.station];
  let reason: string | undefined;
  if (checker === undefined) {
    reason = `no output checker for station ${String(record.station)} (${name}) in this build; the session cannot confirm its output`;
  } else {
    const result = await checker(record);
    if (!result.complete) {
      reason = `station ${name} output is incomplete: ${(result.missing ?? ['see the station prompt']).join(', ')}`;
    }
  }
  if (reason === undefined) return { block: false };
  const fields = { tool: 'Stop', input_summary: reason };
  const unlogged = await logBlocked(record, home, session, fields, ctx.now);
  // The check's text can quote the clone's files.
  return { block: true, reason: visible(reason) + visible(unlogged) };
}
