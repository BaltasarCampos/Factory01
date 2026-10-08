// `factory ci <check>` (contracts/cli.md, contracts/ci-checks.md): the checks the project's CI
// workflows run, from the CLI built at the release pinned on main. Exit 0 passes, 1 fails.
import { checkAppendOnly, LOG_BRANCH } from '../ci/append-only.js';
import type { CommandContext } from '../cli/commands.js';
import { ExitCode, RefusedError, UsageError } from '../cli/env.js';

const KNOWN = [
  'test',
  'lint',
  'scan',
  'coverage',
  'red-green',
  'size',
  'ac-map',
  'guardrail-change',
  'append-only',
  'new-deps',
  'owner-alert',
];

/** Prints the result; a failing check exits 1 with one line per finding. */
function report(ctx: CommandContext, check: string, findings: readonly string[]): number {
  if (findings.length === 0) {
    ctx.io.stdout.write(`${check}: pass\n`);
    return ExitCode.Ok;
  }
  ctx.io.stdout.write(`${check}: fail\n${findings.map((f) => `  ${f}\n`).join('')}`);
  return ExitCode.Refused;
}

function appendOnlyCheck(ctx: CommandContext, args: readonly string[]): number {
  const [base, head] = args;
  if (args.length !== 2 || base === undefined || head === undefined)
    throw new UsageError('usage: factory ci append-only <base> <head> [--branch <name>]');
  const logBranch = ctx.options.branch === LOG_BRANCH;
  const findings = checkAppendOnly(ctx.cwd, base, head, { logBranch, env: ctx.env });
  return report(ctx, 'append-only', findings);
}

const CHECKS: Readonly<Record<string, (ctx: CommandContext, args: readonly string[]) => number>> = {
  'append-only': appendOnlyCheck,
};

export function ci(ctx: CommandContext): Promise<number> {
  const [check = '', ...args] = ctx.positionals;
  const run = Object.hasOwn(CHECKS, check) ? CHECKS[check] : undefined;
  if (run !== undefined) return Promise.resolve(run(ctx, args));
  if (KNOWN.includes(check))
    throw new RefusedError(`factory ci ${check} is not implemented in this build yet`);
  throw new UsageError(`unknown check ${check}; one of ${KNOWN.join(', ')}`);
}
