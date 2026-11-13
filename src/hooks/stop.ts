// `factory hook stop` (AC-063): a session may end only when its station's output exists and
// passes the station's completeness check. Checkers register here as their stations ship
// (Define in slice 12, T045; the others in slice 14, T057; Intake in slice 16b; Build in slice
// 26e-1, T174); a station without one fails closed (Owner decision, slice 7 note B).
//
// After one forced continuation (`stop_hook_active`) the session may end: the check runs again
// and a passing head is still recorded, but the stop is never blocked twice. Only a session whose
// start passed gets a passing head, under `refs/factory/passed/<id>` (slice 28-5b-2).
//
// The role, station, item, clone and repository come from the session's record
// (src/hooks/session.ts), never from the clone, and a blocked stop is logged in the session's own
// log, Define's and Intake's included. No factory git runs in the clone: its head is read inside
// the factory's sandbox into the factory's own clone (session-commits.ts), and checked there; for
// the roles that commit nothing, the hook commits their output there itself (output-commit.ts).
import { existsSync } from 'node:fs';
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
import { HOOK_COMMITS, hookOutput } from './output-commit.js';
import {
  ownOk,
  passedRef,
  sessionOutput,
  UnreadableHead,
  type SessionOutput,
} from './session-commits.js';
import {
  logBlocked,
  passedPath,
  readSessionRecord,
  recordEvent,
  sessionEvents,
  sessionId,
  type SessionRecord,
} from './session.js';
import { appendEvent } from '../events/append.js';

export interface CheckResult {
  complete: boolean;
  /** What is missing or incomplete, for the session to fix. */
  missing?: string[];
  /** Only the Owner's answers are missing: a valid stop, waiting for them (T180). */
  waiting?: boolean;
}

export type StationChecker = (
  r: SessionRecord,
  at: () => SessionOutput,
) => CheckResult | Promise<CheckResult>;

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
 * Output checkers by station, each reading the session's head in the factory's own clone, but
 * Intake's, which reads GitHub; a station without one fails closed. Verify has two outputs, so
 * the record's role picks Security's report or the review (T168).
 */
export const CHECKERS: Partial<Record<Station, StationChecker>> = {
  0: (r, at) => defineStopCheck(r, at()),
  1: intakeStopCheck,
  2: (_r, at) => specStopCheck(at()),
  3: (_r, at) => planStopCheck(at()),
  4: (_r, at) => buildStopCheck(at()),
  5: (r, at) => {
    // What Test may commit is 28-5b-3's: until then its stop fails closed, as the Integrator's.
    if (r.role === 'test')
      return {
        complete: false,
        missing: ["Test's output, which the factory commits only from slice 28-5b-3"],
      };
    return r.role === 'security' ? securityStopCheck(at()) : verifyStopCheck(at());
  },
};

export async function runStop(
  input: HookInput,
  ctx: HookContext,
  checkers: Partial<Record<Station, StationChecker>> = CHECKERS,
): Promise<HookResult> {
  const again = input.stop_hook_active === true;
  const home = ctx.env?.HOME ?? homedir();
  if (!again) {
    const session = sessionId(input.session_id);
    const record = readSessionRecord(home, session);
    const reason = await check(checkers, record, home, session, ctx);
    if (reason === undefined) return { block: false };
    const fields = { tool: 'Stop', input_summary: reason };
    const unlogged = await logBlocked(record, home, session, fields, ctx.now);
    // The check's text can quote the clone's files.
    return { block: true, reason: visible(reason) + visible(unlogged) };
  }
  // The second stop is never blocked, the forced continuation having had its chance: the check
  // runs again so output fixed meanwhile still gets its passing head, and what keeps it from one,
  // a failure of the factory's own included, is logged, never read as passing.
  let record: SessionRecord | undefined;
  let reason: string | undefined;
  let session = '';
  try {
    session = sessionId(input.session_id);
    record = readSessionRecord(home, session);
    reason = await check(checkers, record, home, session, ctx);
  } catch (err) {
    reason = `the factory's own check failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (record !== undefined && reason !== undefined) {
    const summary = `second stop, ended with no passing head: ${visible(reason)}`;
    const event = recordEvent(record, session, {
      kind: 'alert',
      tool: 'Stop',
      input_summary: summary,
    });
    try {
      await appendEvent(sessionEvents(home, session), event, ctx.now);
    } catch {
      // The session ends either way; its log cannot be written.
    }
  }
  return { block: false };
}

/** The station's check of the session's output; undefined when it passes, else why not. */
async function check(
  table: Partial<Record<Station, StationChecker>>,
  record: SessionRecord,
  home: string,
  session: string,
  ctx: HookContext,
): Promise<string | undefined> {
  const checker = table[record.station];
  const name = STATIONS[record.station];
  if (checker === undefined)
    return `no output checker for station ${String(record.station)} (${name}) in this build; the session cannot confirm its output`;
  // Read once, when a checker asks: Intake's never does.
  const env = { ...process.env, ...ctx.env };
  let output: (SessionOutput & { outside?: string[] }) | undefined;
  const at = () =>
    (output ??= HOOK_COMMITS.includes(record.role)
      ? hookOutput(record, home, session, env)
      : sessionOutput(record, home, session, env));
  let result: CheckResult;
  try {
    result = await checker(record, at);
  } catch (err) {
    if (!(err instanceof UnreadableHead)) throw err;
    return `station ${name} output cannot be read: ${err.message}`;
  }
  const outside = output?.outside ?? [];
  if (outside.length > 0) {
    // The session names its own files.
    const shown =
      visible(outside.slice(0, 10).join(', ')) +
      (outside.length > 10 ? `, and ${String(outside.length - 10)} more` : '');
    const event = recordEvent(record, session, {
      kind: 'alert',
      tool: 'Stop',
      input_summary: `changed outside the ${record.role}'s paths, never committed: ${shown}`,
    });
    await appendEvent(sessionEvents(home, session), event, ctx.now);
  }
  if (!result.complete)
    return `station ${name} output is incomplete: ${(result.missing ?? ['see the station prompt']).join(', ')}`;
  // Passed: the head is recorded only for a session whose start passed, and only once read.
  if (output !== undefined && existsSync(passedPath(home, session)))
    ownOk(output.repo, ['update-ref', passedRef(session), output.commit], env);
  return undefined;
}
