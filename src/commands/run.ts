// `factory run [--once]` (contracts/cli.md, FR-005): dispatcher passes one after another on the
// laptop, until a pass starts no session (an Owner gate, or no work), the line halts or a
// launch is refused. Local sessions end before their launch returns, so each pass sees the
// last session's work. Usage limits and caps stop it from slice 32a; the pass cap bounds it.
import type { CommandContext } from '../cli/commands.js';
import { ExitCode } from '../cli/env.js';
import { dispatchOnce, type PassResult } from '../dispatcher/dispatch.js';
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
      result.refused ??
      (result.launched === undefined
        ? 'nothing to start: waiting for the Owner or for work'
        : undefined) ??
      (options.once === true ? '--once' : undefined);
    if (reason !== undefined) return { passes, reason };
  }
  return { passes: limit, reason: `pass cap of ${String(limit)} reached` };
}

export async function run(ctx: CommandContext): Promise<number> {
  const { context, close } = await projectDispatch(ctx);
  let stop;
  try {
    stop = await runLoop(() => dispatchOnce(context), {
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
