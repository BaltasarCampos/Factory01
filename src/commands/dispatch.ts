// `factory dispatch` (contracts/cli.md, FR-016, FR-016f): one dispatcher pass over the project
// clone the command runs in. Main is fetched first; records are checked against the key lists
// of the release pinned on main, and main's history against the same lists. Sessions start
// through the command's launchers, by default the local and cloud ones (T159).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factorySource, releaseKeysFor, secondCopy } from '../approvals/keys.js';
import type { CommandContext } from '../cli/commands.js';
import { ExitCode, RefusedError, UsageError } from '../cli/env.js';
import { dispatchOnce, type DispatchContext, type PassResult } from '../dispatcher/dispatch.js';
import { gatherEvidence } from '../dispatcher/evidence.js';
import { auditMain } from '../dispatcher/history-audit.js';
import { pinnedRelease, stationPrompt } from '../dispatcher/prompts.js';
import { projectHere } from './pause.js';

/**
 * The dispatcher's inputs for the project clone in `ctx.cwd`, and `close` to remove the
 * temporary key lists once the passes are done.
 */
export async function projectDispatch(
  ctx: CommandContext,
): Promise<{ context: DispatchContext; close: () => void }> {
  const project = await projectHere(ctx);
  const fetched = spawnSync('git', ['-C', ctx.cwd, 'fetch', '-q', 'origin', 'main'], {
    env: ctx.env,
    encoding: 'utf8',
  });
  if (fetched.error !== undefined || fetched.status !== 0)
    throw new RefusedError(`cannot fetch main: ${fetched.stderr.trim() || 'git fetch failed'}`);
  const dir = mkdtempSync(join(tmpdir(), 'factory-keys-'));
  const keysFor = releaseKeysFor(ctx.env, dir);
  const out = ctx.io.stdout;
  const context: DispatchContext = {
    projectDir: ctx.cwd,
    keysFor,
    secondCopy: secondCopy(ctx.env, project.home),
    auditHistory: (_config, history) =>
      Promise.resolve(auditMain(ctx.cwd, 'origin/main', history, ctx.env)),
    gatherEvidence: gatherEvidence({
      ...{ projectDir: ctx.cwd, gh: { env: ctx.env } },
      factory: factorySource(ctx.env),
    }),
    launchers: ctx.launchers,
    stationPrompt: (pin, facts) =>
      stationPrompt(pinnedRelease(factorySource(ctx.env), pin, ctx.env), facts),
    logEvent: (issue, event) => {
      out.write(`event #${String(issue)}: ${JSON.stringify(event)}\n`);
      return Promise.resolve();
    },
    now: ctx.now,
    gh: { env: ctx.env },
  };
  const close = () => {
    rmSync(dir, { recursive: true, force: true });
  };
  return { context, close };
}

/** What one pass did, for the Owner or the routine log. */
export function passLines(r: PassResult): string {
  const lines = [
    ...(r.halted === undefined ? [] : [`halted: ${r.halted}`]),
    ...r.moves.map((m) => `#${String(m.issue)} ${m.from} → ${m.to}: ${m.reason}`),
    ...r.skipped.map((s) => `#${String(s.issue)} not admitted: ${s.reason}`),
    ...(r.launched === undefined
      ? []
      : [
          `started ${r.launched.role} (station ${String(r.launched.station)}) for #${String(r.launched.issue)} on ${r.launched.branch}: ${r.launched.mode} session ${r.launched.sessionId}`,
        ]),
    ...(r.refused === undefined ? [] : [`no session started: ${r.refused}`]),
  ];
  return lines.map((l) => `${l}\n`).join('');
}

export async function dispatch(ctx: CommandContext): Promise<number> {
  if (ctx.options['attack-suite'] === true)
    throw new UsageError('--attack-suite is not in this build (slice 29c)');
  const { context, close } = await projectDispatch(ctx);
  try {
    const result = await dispatchOnce(context);
    ctx.io.stdout.write(passLines(result) || 'nothing to do\n');
  } finally {
    close();
  }
  return ExitCode.Ok;
}
