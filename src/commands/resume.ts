// `factory resume [station]` (contracts/cli.md, FR-007d, AC-077): sign a `resume` record for
// the scope, post it to the Owner inbox, and only then remove the `pause:` label.
//
// A resume lifts only pauses added before its signed `timestamp`, so a laptop clock behind
// GitHub's would sign a record that lifts nothing. The latest pause label-add time is GitHub's
// own clock: the record is signed at the later of now and that time plus one second, with a
// warning when the laptop is more than a minute behind.
//
// The approval summary (AC-096) shows what was paused, when and by whom, the alerts raised and
// the items whose `state:` label changed since then. The pause began at the first add of its
// label that no verified resume record lifts. Nothing is signed when any of it cannot be read.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from '../cli/commands.js';
import { ExitCode, RefusedError } from '../cli/env.js';
import { mainKeys, secondCopy } from '../approvals/keys.js';
import { newNonce, recordTimestamp, serialise } from '../approvals/record.js';
import { listComments } from '../github/comments.js';
import { asList, Fields, gh, repoArg } from '../github/gh.js';
import { removeLabel } from '../github/labels.js';
import { timeline } from '../github/timeline.js';
import type { ApprovalRecord } from '../model/types.js';
import { parseAlert } from '../notify/inbox.js';
import { buildSummary, type PauseFacts } from '../notify/summary.js';
import { resumeEntries, type LabelEvent } from '../pause/derive.js';
import { postSigned } from './approve.js';
import { projectHere, scopeOf } from './pause.js';

type Project = Awaited<ReturnType<typeof projectHere>>;

const SKEW_WARNING_MS = 60_000;

async function pauseFacts(
  project: Project,
  scope: string,
  events: readonly LabelEvent[],
): Promise<PauseFacts> {
  const { repo, inboxIssue: inbox } = project;
  const env = project.env ?? process.env;
  const scratch = mkdtempSync(join(tmpdir(), 'factory-keys-'));
  try {
    const keys = mainKeys(project.cwd, env, scratch);
    const comments = await listComments(repo, inbox, project);
    const check = { keys, secondCopy: secondCopy(env, project.home), repo, inboxIssue: inbox };
    const lifts = resumeEntries(comments, check)
      .filter((r) => r.verified && r.record.scope === scope)
      .map((r) => Date.parse(r.record.timestamp));
    const adds = events.filter((e) => e.event === 'labeled');
    const start = adds.find((e) => !lifts.some((t) => t > Date.parse(e.createdAt))) ?? adds.at(-1);
    if (start === undefined) throw new Error('no pause label was added');
    const since = (at: string) => Date.parse(at) >= Date.parse(start.createdAt);

    const alerts = comments
      .filter((c) => since(c.createdAt))
      .flatMap((c) => {
        const a = parseAlert(c);
        return a === undefined ? [] : [{ at: c.createdAt, ...a }];
      });
    const updated = `updated:>=${start.createdAt}`;
    const args = ['issue', 'list', '--repo', repoArg(repo), '--state', 'all', '--search', updated];
    const listed = await gh([...args, '--json', 'number,title', '--limit', '1000'], {
      ...project,
      json: true,
    });
    const items: PauseFacts['items'][number][] = [];
    for (const value of asList(listed, 'issues')) {
      const f = Fields.of(value, 'issue');
      const number = f.num('number');
      if (number === inbox) continue;
      const states = (await timeline(repo, number, project))
        .filter((e) => e.event === 'labeled' && e.label.startsWith('state:') && since(e.createdAt))
        .map((e) => e.label);
      if (states.length > 0) items.push({ number, title: f.str('title'), states });
    }
    return { label: start.label, at: start.createdAt, by: start.actor, alerts, items };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new RefusedError(
      `cannot read what happened during the pause, so nothing is signed: ${why}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

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

  const pause = await pauseFacts(project, scope, events);
  const issue = { number: project.inboxIssue, title: 'Owner inbox', body: '', labels: [] };
  const summary = buildSummary({ gate: 'resume', issue, pause });
  if (!summary.ok)
    throw new RefusedError(
      `not signing: the summary is incomplete:\n  ${summary.missing.join('\n  ')}`,
    );
  ctx.io.stdout.write(`${summary.text}\n`);

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
