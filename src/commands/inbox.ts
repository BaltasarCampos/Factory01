// `factory inbox [--all]` (contracts/cli.md, FR-034a): list unread Owner-inbox alerts, or all
// of them with --all, then mark them read.
import type { CommandContext } from '../cli/commands.js';
import { ExitCode, RefusedError } from '../cli/env.js';
import { alertLines, listAlerts, markRead, projectInbox, readIds } from '../notify/inbox.js';

export async function inbox(ctx: CommandContext): Promise<number> {
  const target = await projectInbox(ctx.cwd, ctx.env);
  if (target === undefined) {
    throw new RefusedError('factory inbox: no .factory/config here; run it in a project clone');
  }
  const alerts = await listAlerts(target);
  const read = readIds(target.home);
  const unread = alerts.filter((a) => !read.has(a.id));
  const shown = ctx.options.all === true ? alerts : unread;
  if (shown.length === 0) {
    ctx.io.stdout.write(ctx.options.all === true ? 'No alerts.\n' : 'No unread alerts.\n');
  } else {
    ctx.io.stdout.write(alertLines(shown));
  }
  markRead(
    target.home,
    unread.map((a) => a.id),
  );
  return ExitCode.Ok;
}
