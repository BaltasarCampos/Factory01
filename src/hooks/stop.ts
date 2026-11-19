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
import { homedir } from 'node:os';
import { EnvironmentError } from '../cli/env.js';
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
import { belowLogs, commitEvents, LogNotFile } from './events-commit.js';
import { HOOK_COMMITS, hookOutput, type Outside } from './output-commit.js';
import {
  passedRef,
  readRef,
  sessionOutput,
  STOP_DEADLINE,
  UnreadableHead,
  type SessionOutput,
  writeRef,
} from './session-commits.js';
import {
  logBlocked,
  hasPassed,
  readSessionRecord,
  recordEvent,
  sessionEvents,
  sessionId,
  type SessionRecord,
} from './session.js';
import { appendEvent } from '../events/append.js';
import { pastDeadline, withDeadline } from '../cli/deadline.js';

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
    // Test's output is only new test files, so its head itself is no output.
    if (r.role === 'test') {
      const output = at();
      return output.commit === output.head
        ? { complete: false, missing: ['a new test file: this session added none'] }
        : { complete: true };
    }
    return r.role === 'security' ? securityStopCheck(at()) : verifyStopCheck(at());
  },
};

export function runStop(
  input: HookInput,
  ctx: HookContext,
  checkers: Partial<Record<Station, StationChecker>> = CHECKERS,
  limit = STOP_DEADLINE,
): Promise<HookResult> {
  return withDeadline(limit, () => stop(input, ctx, checkers));
}

async function stop(
  input: HookInput,
  ctx: HookContext,
  checkers: Partial<Record<Station, StationChecker>>,
): Promise<HookResult> {
  const again = input.stop_hook_active === true;
  const home = ctx.env?.HOME ?? homedir();
  if (!again) {
    const session = sessionId(input.session_id);
    const record = readSessionRecord(home, session);
    let reason: string | undefined;
    try {
      reason = await check(checkers, record, home, session, ctx, false);
    } catch (err) {
      // The factory's own failure blocks the stop too, and is logged as every block is.
      const why = err instanceof Error ? err.message : String(err);
      const fields = { tool: 'Stop', input_summary: why };
      const unlogged = await logBlocked(record, home, session, fields, ctx.now);
      // As the reason path does: an unwritten block is said, not lost.
      if (unlogged !== '' && err instanceof Error) err.message += visible(unlogged);
      throw err;
    }
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
    reason = await check(checkers, record, home, session, ctx, true);
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

/**
 * The station's check of the session's output; undefined when it passes, else why not. The passing
 * head is removed before the output is read, so it always names the commit the last stop passed at.
 */
async function check(
  table: Partial<Record<Station, StationChecker>>,
  record: SessionRecord,
  home: string,
  session: string,
  ctx: HookContext,
  again: boolean,
): Promise<string | undefined> {
  const env = { ...process.env, ...ctx.env };
  const checker = table[record.station];
  const name = STATIONS[record.station];
  if (checker === undefined)
    return `no output checker for station ${String(record.station)} (${name}) in this build; the session cannot confirm its output`;
  // Read once, when a checker asks: Intake's never does, and has no passing head. Every checker
  // that reads the output reads it first, so the passing head goes at the start of its check.
  let output: (SessionOutput & Partial<Outside>) | undefined;
  const read = () => {
    clearPassed(record.project, session, env);
    return HOOK_COMMITS.includes(record.role)
      ? hookOutput(record, home, session, env)
      : sessionOutput(record, home, session, env);
  };
  const at = () => (output ??= read());
  let result: CheckResult;
  try {
    result = await checker(record, at);
  } catch (err) {
    if (!(err instanceof UnreadableHead)) throw err;
    return `station ${name} output cannot be read: ${err.message}`;
  }
  // A passing head needs the output read; Intake's, from GitHub, never has one.
  if (result.complete && output === undefined && record.station !== 1)
    throw new EnvironmentError(
      `the station ${name} check passed without reading the session's output, so it has no passing head: the factory's own error`,
    );
  // Once per session: at the stop that passes, or at the second, never blocked.
  if (output !== undefined && (result.complete || again)) {
    const summary = outsideSummary(record.role, output);
    if (summary !== undefined) {
      const event = recordEvent(record, session, {
        kind: 'alert',
        tool: 'Stop',
        input_summary: summary,
      });
      await appendEvent(sessionEvents(home, session), event, ctx.now);
    }
  }
  // A path below an event log makes it a folder, which no events commit can append to.
  const below = output === undefined ? [] : belowLogs(output, env);
  if (below.length > 0) {
    const shown =
      below.slice(0, 10).join(', ') +
      (below.length > 10 ? `, and ${String(below.length - 10)} more` : '');
    return `${shown}: below an event log, which only the factory appends to; remove them in a new commit`;
  }
  if (!result.complete)
    return `station ${name} output is incomplete: ${(result.missing ?? ['see the station prompt']).join(', ')}`;
  // Passed: the head is recorded only for a session whose start passed, and only once read.
  if (output !== undefined && hasPassed(home, session)) {
    // The passing head names the events commit on the head the check passed; with none, no
    // passing head, and an alert says why.
    let events: string;
    try {
      events = commitEvents(record, home, session, output.commit, env, ctx.now);
    } catch (err) {
      // Past the deadline the first stop blocks, so that the second checks again.
      const over = pastDeadline();
      if (over !== undefined) throw over;
      const why = err instanceof Error ? err.message : String(err);
      const summary =
        err instanceof LogNotFile
          ? `no passing head: ${visible(why)}`
          : `no passing head: the factory could not append the session's log to the item's event log, its own error, which this session cannot fix: ${visible(why)}`;
      const event = recordEvent(record, session, {
        kind: 'alert',
        tool: 'Stop',
        input_summary: summary,
      });
      await appendEvent(sessionEvents(home, session), event, ctx.now);
      return undefined;
    }
    // Removed before the output was read: a ref there now is another hook's.
    writeRef(output.repo, passedRef(session), '', events, env);
  }
  return undefined;
}

/**
 * Removes the session's passing head, only when it exists: `update-ref -d` takes the packed-refs
 * lock even for a ref that is absent, and a lock left in the factory's clone is not the session's.
 */
function clearPassed(repo: string, session: string, env: NodeJS.ProcessEnv) {
  const ref = passedRef(session);
  const found = readRef(repo, ref, env);
  if (found !== undefined) writeRef(repo, ref, found, undefined, env);
}

/** The alert for what changed outside the role's paths, or why it could not be listed; or none. */
function outsideSummary(role: string, output: Partial<Outside>): string | undefined {
  if (output.unlisted !== undefined)
    return `the factory could not list the changes outside the ${role}'s paths: ${visible(output.unlisted)}`;
  const outside = output.outside ?? [];
  if (outside.length === 0) return undefined;
  // The session names its own files.
  const shown =
    visible(outside.slice(0, 10).join(', ')) +
    (outside.length > 10 ? `, and ${String(outside.length - 10)} more` : '');
  return `changed outside the ${role}'s paths, never committed: ${shown}`;
}
