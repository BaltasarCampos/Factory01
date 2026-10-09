// `factory ci <check>` (contracts/cli.md, contracts/ci-checks.md): the checks the project's CI
// workflows run, from the CLI built at the release pinned on main. Exit 0 passes, 1 fails.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkAcMap, checkedSet, passingTitles } from '../ci/ac-map.js';
import { checkAppendOnly, LOG_BRANCH } from '../ci/append-only.js';
import { meetsThreshold, measureCoverage, parseLcov } from '../ci/coverage.js';
import { redGreen } from '../ci/red-green.js';
import { measureSize } from '../ci/size.js';
import type { CommandContext } from '../cli/commands.js';
import { ExitCode, RefusedError, UsageError } from '../cli/env.js';
import { fileAt, mergeBase, safeDiff } from '../git/diff.js';
import { parseConfig, RELEASE_LIMITS } from '../model/config.js';
import type { ProjectConfig, Tier } from '../model/types.js';

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

/** Prints the result: `details` first, then pass, or fail with one line per finding. */
function report(
  ctx: CommandContext,
  check: string,
  findings: readonly string[],
  details: readonly string[] = [],
): number {
  const lines = (rows: readonly string[]) => rows.map((r) => `  ${r}\n`).join('');
  ctx.io.stdout.write(lines(details).replace(/^ {2}/, `${check}: `));
  if (findings.length === 0) {
    ctx.io.stdout.write(`${check}: pass\n`);
    return ExitCode.Ok;
  }
  ctx.io.stdout.write(`${check}: fail\n${lines(findings)}`);
  return ExitCode.Refused;
}

/** `<base> <head>`, or a usage error naming the check's arguments. */
function range(args: readonly string[], usage: string): [string, string] {
  const [base, head] = args;
  if (args.length !== 2 || base === undefined || head === undefined)
    throw new UsageError(`usage: factory ci ${usage}`);
  return [base, head];
}

/** Main's `.factory/config`, never the pull request's: its limits only make the release's stricter. */
function mainConfig(ctx: CommandContext): ProjectConfig {
  const bytes = fileAt(ctx.cwd, 'origin/main', '.factory/config', ctx.env);
  if (bytes === undefined) throw new RefusedError('cannot read origin/main:.factory/config');
  return parseConfig(bytes.toString('utf8'));
}

/**
 * A report the CI job wrote before this check, in the checkout. A report committed at the head
 * is refused: the pull request would be grading itself, and `size` never counts `coverage/`.
 */
function readReport(ctx: CommandContext, path: string, head: string): string {
  if (fileAt(ctx.cwd, head, path, ctx.env) !== undefined)
    throw new RefusedError(`${path} is committed at the head; CI writes its own reports`);
  const full = join(ctx.cwd, path);
  if (!existsSync(full)) throw new RefusedError(`${path} not found; run the tests first`);
  return readFileSync(full, 'utf8');
}

function sizeCheck(ctx: CommandContext, args: readonly string[]): number {
  const [base, head] = range(args, 'size <base> <head>');
  const limit = Math.min(RELEASE_LIMITS.sizeLimitLines, mainConfig(ctx).size_limit_lines);
  const start = mergeBase(ctx.cwd, base, head, ctx.env);
  const { lines, listed } = measureSize(safeDiff(ctx.cwd, start, head, ctx.env));
  const summary = `${String(lines)} changed lines (limit ${String(limit)})`;
  const findings = lines > limit ? [`${summary}: split the work or ask the Owner`] : [];
  return report(ctx, 'size', findings, [summary, ...listed]);
}

function coverageCheck(ctx: CommandContext, args: readonly string[]): number {
  const [base, head] = range(args, 'coverage <base> <head>');
  const threshold = Math.max(RELEASE_LIMITS.coverageMin, mainConfig(ctx).coverage_min);
  const start = mergeBase(ctx.cwd, base, head, ctx.env);
  const lcov = parseLcov(readReport(ctx, 'coverage/lcov.info', head), ctx.cwd);
  const result = measureCoverage(safeDiff(ctx.cwd, start, head, ctx.env), lcov);
  const summary = `${String(result.covered)} of ${String(result.total)} changed lines covered (threshold ${String(threshold)}%)`;
  const findings = [
    ...result.problems,
    ...(meetsThreshold({ ...result, problems: [] }, threshold) ? [] : [summary]),
  ];
  return report(ctx, 'coverage', findings, [summary]);
}

/** `--tier`, from the issue's label: unverified, and used in CI only. */
function tierOption(ctx: CommandContext): { tier: Tier | undefined; label: string } {
  const raw = ctx.options.tier;
  if (raw !== undefined && raw !== '1' && raw !== '2' && raw !== '3')
    throw new UsageError('--tier must be 1, 2 or 3');
  return {
    tier: raw === undefined ? undefined : (Number(raw) as Tier),
    label: raw ?? '1, none given',
  };
}

/** `--branch`, the pull request's head branch, which names the item's feature folder. */
function branchOption(ctx: CommandContext, check: string): string {
  const { branch } = ctx.options;
  if (typeof branch !== 'string')
    throw new UsageError(`factory ci ${check} needs --branch <head branch>`);
  return branch;
}

function acMapCheck(ctx: CommandContext, args: readonly string[]): number {
  const [base, head] = range(args, 'ac-map <base> <head> --branch <name> [--tier <1|2|3>]');
  const branch = branchOption(ctx, 'ac-map');
  const { tier, label } = tierOption(ctx);
  const set = checkedSet(ctx.cwd, base, head, tier, branch, ctx.env);
  const titles = passingTitles(readReport(ctx, 'coverage/vitest-results.json', head));
  const checked = `${String(set.ids.size)} checked acceptance criteria (tier ${label})`;
  return report(ctx, 'ac-map', checkAcMap(set, titles), [checked]);
}

function appendOnlyCheck(ctx: CommandContext, args: readonly string[]): number {
  const [base, head] = range(args, 'append-only <base> <head> [--branch <name>] [--push]');
  const logBranch = ctx.options.branch === LOG_BRANCH;
  const push = ctx.options.push === true;
  const findings = checkAppendOnly(ctx.cwd, base, head, { logBranch, push, env: ctx.env });
  return report(ctx, 'append-only', findings);
}

function redGreenCheck(ctx: CommandContext, args: readonly string[]): number {
  const [base, head] = range(args, 'red-green <base> <head> --branch <name> [--tier <1|2|3>]');
  const branch = branchOption(ctx, 'red-green');
  const { tier, label } = tierOption(ctx);
  const install = join(ctx.cwd, 'node_modules');
  const result = redGreen(ctx.cwd, base, head, { tier, branch, install, env: ctx.env });
  if (result.skipped) {
    const files = result.files.map((f) => `  ${f}\n`).join('');
    ctx.io.stdout.write(`red-green skipped: only test code changed\n${files}`);
    return ExitCode.Ok;
  }
  const summary = `${String(result.seen)} of ${String(result.checked)} checked criteria seen failing first (tier ${label})`;
  return report(ctx, 'red-green', result.findings, [summary]);
}

const CHECKS: Readonly<Record<string, (ctx: CommandContext, args: readonly string[]) => number>> = {
  'append-only': appendOnlyCheck,
  size: sizeCheck,
  coverage: coverageCheck,
  'ac-map': acMapCheck,
  'red-green': redGreenCheck,
};

export function ci(ctx: CommandContext): Promise<number> {
  const [check = '', ...args] = ctx.positionals;
  const run = Object.hasOwn(CHECKS, check) ? CHECKS[check] : undefined;
  if (run !== undefined) return Promise.resolve(run(ctx, args));
  if (KNOWN.includes(check))
    throw new RefusedError(`factory ci ${check} is not implemented in this build yet`);
  throw new UsageError(`unknown check ${check}; one of ${KNOWN.join(', ')}`);
}
