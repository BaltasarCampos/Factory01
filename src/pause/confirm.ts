// The Owner's confirmation, and the pause warning (AC-078) that `factory merge` and `factory
// deploy` share: a pause is telemetry, so it is a warning the Owner must confirm, never a refusal
// by itself. The pause is derived from the inbox issue's labels and its verified resume records;
// when they cannot be read, the command stops.
import { secondCopy } from '../approvals/keys.js';
import type { CommandContext } from '../cli/commands.js';
import { RefusedError } from '../cli/env.js';
import { listComments } from '../github/comments.js';
import { timeline } from '../github/timeline.js';
import type { MainContext } from '../merge/context.js';
import { STATIONS } from '../model/types.js';
import { derivePause, resumeEntries } from './derive.js';

/** Go on only when the Owner answers yes; `nothing` ends the refusal. */
export async function confirm(
  ctx: CommandContext,
  warning: string,
  question: string,
  nothing: string,
): Promise<void> {
  ctx.io.stderr.write(`warning: ${warning}\n`);
  const answer = (await ctx.ask(`${question} [y/N] `)).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes')
    throw new RefusedError(`the Owner did not confirm; ${nothing}`);
}

/** Asks `question` when the line or a station is paused. */
export async function confirmPause(
  ctx: CommandContext,
  at: MainContext,
  question: string,
  nothing: string,
): Promise<void> {
  const { repo, inbox_issue: inbox } = at.config;
  const options = { env: at.env };
  const resumes = resumeEntries(await listComments(repo, inbox, options), {
    ...{ keys: at.keys, secondCopy: secondCopy(at.env, at.home) },
    ...{ repo, inboxIssue: inbox },
  });
  const pause = derivePause(await timeline(repo, inbox, options), resumes);
  const paused = [
    ...(pause.line ? ['pause:line'] : []),
    ...[...pause.stations].map((s) => `pause:${STATIONS[s]}`),
  ];
  if (paused.length > 0)
    await confirm(ctx, `the line is paused (${paused.join(', ')})`, question, nothing);
}
