// `factory run [--once]` (contracts/cli.md, FR-005): dispatcher passes one after another on the
// laptop, until a pass starts no session (an Owner gate, or no work), the line halts, a session
// fails or a launch is refused. Local sessions end before their launch returns, so each pass sees
// the last session's work. Usage limits stop it from slice 32a; the pass cap bounds it, and each
// session's caps bound that session. While one runs, a heartbeat line about once a minute names
// its role, item, elapsed time and turns so far (T061).
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { CommandContext } from '../cli/commands.js';
import { ExitCode } from '../cli/env.js';
import { dispatchOnce, type PassResult } from '../dispatcher/dispatch.js';
import type { Alert } from '../model/types.js';
import { alert, listAlerts, type InboxTarget, type NewAlert } from '../notify/inbox.js';
import { visible } from '../notify/summary.js';
import { passLines, projectDispatch } from './dispatch.js';

export const RUN_PASS_LIMIT = 20;

export async function runLoop(
  pass: () => Promise<PassResult>,
  options: { once?: boolean; limit?: number; report?: (result: PassResult) => void },
): Promise<{ passes: number; reason: string }> {
  const limit = options.limit ?? RUN_PASS_LIMIT;
  for (let passes = 1; passes <= limit; passes++) {
    const result = await pass();
    options.report?.(result);
    const reason =
      result.halted ??
      result.failed ??
      result.refused ??
      (result.launched !== undefined
        ? undefined
        : (result.held ?? []).length > 0
          ? `nothing started: ${(result.held ?? []).map((h) => `#${String(h.issue)}`).join(', ')} held`
          : 'nothing to start: waiting for the Owner or for work') ??
      (options.once === true ? '--once' : undefined);
    if (reason !== undefined) return { passes, reason };
  }
  return { passes: limit, reason: `pass cap of ${String(limit)} reached` };
}

const why = (err: unknown) => visible(err instanceof Error ? err.message : String(err));
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The alert for a pass that threw, the same from pass to pass for the same failure: main's head,
 * the error's kind and its first line, with no temporary path, session id, pid or time in it.
 */
export function thrownText(head: string, err: unknown): string {
  const kind = err instanceof Error ? err.constructor.name : typeof err;
  const [line = ''] = (err instanceof Error ? err.message : String(err)).split('\n');
  const temp = new RegExp(`(?:${[tmpdir(), '/tmp'].map(escaped).join('|')})/\\S*`, 'g');
  const stable = line
    .replace(temp, '<tmp>')
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)?/g, '<time>')
    .replace(/\b(pids?|process(?:es)?|group) \d+(?:, \d+)*/gi, '$1 <pid>')
    .replace(/ -\d+\b/g, ' -<pid>');
  return visible(`factory run stopped: a pass threw ${kind}: ${stable}; main is at ${head}`).trim();
}

/**
 * One urgent alert per main head and message for a pass that threw (T061): when the inbox's
 * alerts cannot be read it is posted anyway, an extra alert being the safe direction, and when the
 * post fails too, why goes to stderr, beside the pass's own error.
 */
export async function alertThrown(
  inbox: InboxTarget,
  text: string,
  stderr: { write: (s: string) => void },
  deps: { read?: () => Promise<Alert[]>; post?: (input: NewAlert) => Promise<unknown> } = {},
): Promise<void> {
  let posted: Alert[] = [];
  try {
    posted = await (deps.read ?? (() => listAlerts(inbox)))();
  } catch (err) {
    stderr.write(
      `factory run: the inbox's alerts cannot be read, so it is alerted anyway: ${why(err)}\n`,
    );
  }
  if (posted.some((a) => a.kind === 'pass-threw' && a.text === text)) return;
  try {
    await (deps.post ?? ((input) => alert(inbox, input)))({
      urgency: 'urgent',
      kind: 'pass-threw',
      text,
    });
  } catch (err) {
    stderr.write(`factory run: ${text}\nfactory run: its alert cannot be posted: ${why(err)}\n`);
  }
}

export async function run(ctx: CommandContext): Promise<number> {
  const { context, close, inbox } = await projectDispatch(ctx);
  let stop;
  try {
    const heartbeat = (line: string) => {
      ctx.io.stdout.write(`${line}\n`);
    };
    const pass = async () => {
      try {
        return await dispatchOnce({ ...context, heartbeat });
      } catch (err) {
        const main = spawnSync('git', ['-C', ctx.cwd, 'rev-parse', '--verify', 'origin/main'], {
          ...{ env: ctx.env, encoding: 'utf8' },
        });
        const head = main.status === 0 ? main.stdout.trim().slice(0, 12) : 'an unknown commit';
        await alertThrown(inbox, thrownText(head, err), ctx.io.stderr);
        throw err;
      }
    };
    stop = await runLoop(pass, {
      once: ctx.options.once === true,
      report: (result) => {
        ctx.io.stdout.write(passLines(result));
      },
    });
  } finally {
    close();
  }
  ctx.io.stdout.write(`stopped after ${String(stop.passes)} passes: ${stop.reason}\n`);
  return ExitCode.Ok;
}
