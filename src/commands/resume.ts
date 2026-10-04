// `factory resume [station]` (contracts/cli.md, FR-007d, AC-077): sign a `resume` record for
// the scope, post it to the Owner inbox, and only then remove the `pause:` label.
//
// A resume lifts only pauses added before its signed `timestamp`, so a laptop clock behind
// GitHub's would sign a record that lifts nothing. The latest pause label-add time is GitHub's
// own clock: the record is signed at the later of now and that time plus one second, with a
// warning when the laptop is more than a minute behind.
import type { CommandContext } from '../cli/commands.js';
import { ExitCode, RefusedError } from '../cli/env.js';
import { newNonce, recordTimestamp, serialise } from '../approvals/record.js';
import { removeLabel } from '../github/labels.js';
import { timeline } from '../github/timeline.js';
import type { ApprovalRecord } from '../model/types.js';
import { postSigned } from './approve.js';
import { projectHere, scopeOf } from './pause.js';

const SKEW_WARNING_MS = 60_000;

export async function resume(ctx: CommandContext): Promise<number> {
  const scope = scopeOf(ctx.positionals[0]);
  const project = await projectHere(ctx);
  const label = `pause:${scope}`;
  const events = (await timeline(project.repo, project.inboxIssue, project)).filter(
    (e) => e.label === label,
  );
  const lastAdd = events.filter((e) => e.event === 'labeled').at(-1);
  if (lastAdd === undefined)
    throw new RefusedError(
      `${label} was never added to ${project.repo}#${String(project.inboxIssue)}; nothing to resume`,
    );

  const pausedAt = Date.parse(lastAdd.createdAt);
  const now = Math.floor(ctx.now().getTime() / 1000) * 1000;
  const timestamp = recordTimestamp(new Date(Math.max(now, pausedAt + 1000)));
  if (pausedAt - now > SKEW_WARNING_MS)
    ctx.io.stderr.write(
      `warning: the laptop clock is at least ${String(Math.round((pausedAt - now) / 1000))} s ` +
        `behind GitHub's (${label} was added at ${lastAdd.createdAt}); signing with ${timestamp}\n`,
    );

  const record: ApprovalRecord = {
    repo: project.repo,
    issue: project.inboxIssue,
    gate: 'resume',
    scope,
    timestamp,
    nonce: newNonce(),
  };
  ctx.io.stdout.write(`Signing for ${project.repo}#${String(project.inboxIssue)}:\n\n`);
  ctx.io.stdout.write(`${serialise(record)}\n`);
  await postSigned(ctx, project, record);
  if (events.at(-1)?.event === 'labeled')
    await removeLabel(project.repo, project.inboxIssue, label, project);
  ctx.io.stdout.write(`Resumed: ${label} lifted.\n`);
  return ExitCode.Ok;
}
