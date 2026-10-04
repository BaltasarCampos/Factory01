// `factory pause [station]` (contracts/cli.md, FR-007c): add `pause:line` or `pause:<station>`
// to the Owner inbox issue. Anyone may pause, from anywhere, without a signature; only a signed
// `factory resume` ends a pause (FR-029a).
import type { CommandContext } from '../cli/commands.js';
import { ExitCode, RefusedError, UsageError } from '../cli/env.js';
import { addLabel } from '../github/labels.js';
import { STATIONS, type StationName } from '../model/types.js';
import { projectInbox, type InboxTarget } from '../notify/inbox.js';

export type Scope = 'line' | StationName;

/** The scope named by the optional station argument. */
export function scopeOf(arg: string | undefined): Scope {
  if (arg === undefined) return 'line';
  const station = STATIONS.find((s) => s === arg);
  if (station === undefined)
    throw new UsageError(`unknown station ${JSON.stringify(arg)}; one of ${STATIONS.join(', ')}`);
  return station;
}

/** The project clone the command runs in, with its inbox and the laptop's home. */
export async function projectHere(
  ctx: CommandContext,
): Promise<InboxTarget & { home: string; cwd: string }> {
  const target = await projectInbox(ctx.cwd, ctx.env);
  if (target === undefined)
    throw new RefusedError(
      `factory ${ctx.name}: no .factory/config here; run it in a project clone`,
    );
  return { ...target, cwd: ctx.cwd };
}

export async function pause(ctx: CommandContext): Promise<number> {
  const scope = scopeOf(ctx.positionals[0]);
  const project = await projectHere(ctx);
  await addLabel(project.repo, project.inboxIssue, `pause:${scope}`, project);
  ctx.io.stdout.write(
    `Paused ${scope === 'line' ? 'the whole line' : `station ${scope}`}: pause:${scope} added to ` +
      `${project.repo}#${String(project.inboxIssue)}. Only \`factory resume\` lifts it.\n`,
  );
  return ExitCode.Ok;
}
