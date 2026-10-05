// `factory adopt <owner/repo>` (contracts/cli.md, FR-003, AC-007, AC-064): attach the factory to
// an existing private repo with the same consent and install steps as `factory new`. Main's
// last unsigned commit becomes `baseline` and an Owner-signed adopt commit follows it; Define
// reads the existing code. On a repo already adopted, Define re-runs without reinstalling.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from '../cli/commands.js';
import { ExitCode, RefusedError, UsageError } from '../cli/env.js';
import { cloneRepo, visibility } from '../github/repo.js';
import {
  CONFIG_PATH,
  createDefineBranch,
  DEFINE_BRANCH,
  installProject,
} from '../install/project.js';
import { parseConfig } from '../model/config.js';
import { formatReleasePin } from '../model/naming.js';
import { askConsent, commitAndPush, git, ownerHome, startDefine, verifiedRelease } from './new.js';

const ADOPTED_INPUT =
  'This repository was adopted: the existing code on main is your input. Read it before asking.';

export async function adopt(ctx: CommandContext): Promise<number> {
  const repo = ctx.positionals[0] ?? '';
  const name = /^[A-Za-z0-9_.-]+\/([A-Za-z0-9_-][A-Za-z0-9_.-]*)$/.exec(repo)?.[1];
  if (name === undefined) throw new UsageError(`expected owner/repo, not ${JSON.stringify(repo)}`);
  const home = ownerHome(ctx);
  const options = { env: ctx.env };
  const seen = await visibility(repo, options);
  if (seen !== 'private')
    throw new RefusedError(`${repo} is ${seen}; the factory adopts only private repositories`);

  const workdir = join(ctx.cwd, name);
  const fresh = !existsSync(workdir);
  if (fresh) await cloneRepo(repo, workdir, options);
  else if (!git(workdir, ['fetch', '-q', 'origin'], ctx.env).ok)
    throw new RefusedError(`${workdir} exists and is not a clone of ${repo}`);

  const installed = git(workdir, ['show', `origin/main:${CONFIG_PATH}`], ctx.env);
  if (installed.ok) {
    // Already adopted: Define re-runs on the installed guardrails, and its new backlog waits for
    // the Owner again (AC-064).
    const config = parseConfig(`${installed.out}\n`);
    if (config.repo !== repo) throw new RefusedError(`${workdir} is a clone of ${config.repo}`);
    const define = ['ls-remote', '--exit-code', 'origin', `refs/heads/${DEFINE_BRANCH}`];
    if (!git(workdir, define, ctx.env).ok) {
      const push = ['push', '-q', 'origin', `origin/main:refs/heads/${DEFINE_BRANCH}`];
      if (!git(workdir, push, ctx.env).ok)
        throw new RefusedError(`could not push ${DEFINE_BRANCH}`);
    }
    return startDefine(ctx, config, ADOPTED_INPUT);
  }
  if (!fresh)
    throw new RefusedError(`${workdir} already exists; adopt ${repo} from another directory`);

  const scratch = mkdtempSync(join(tmpdir(), 'factory-adopt-'));
  let pushed = false;
  try {
    const head = git(workdir, ['rev-parse', '-q', '--verify', 'HEAD'], ctx.env);
    const branch = git(workdir, ['symbolic-ref', '--short', 'HEAD'], ctx.env).out;
    if (head.ok && branch !== 'main')
      throw new RefusedError(`${repo}'s default branch is ${branch}; the factory works on main`);
    if (!head.ok) git(workdir, ['symbolic-ref', 'HEAD', 'refs/heads/main'], ctx.env);

    const release = verifiedRelease(ctx.env, home, scratch);
    const agents = await askConsent(ctx);
    if (agents === undefined) {
      ctx.io.stdout.write('No choice made; nothing was created.\n');
      return ExitCode.Refused;
    }
    // A commit cannot hold its own hash, so the last unsigned commit is recorded instead.
    const baseline = head.ok ? { baseline: head.out } : {};
    await installProject({ repo, workdir, ...release, agents, ...baseline, ...options });
    const pin = formatReleasePin(release.pin);
    commitAndPush(ctx, home, workdir, `factory adopt: ${repo}\n\nFactory release ${pin}.`);
    pushed = true;
    createDefineBranch(workdir, ctx.env);
    ctx.io.stdout.write(`Adopted ${repo} in ${workdir}, pinned to ${pin}.\n`);
    return await startDefine(ctx, { repo, agents }, ADOPTED_INPUT);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    // Nothing reached main: leave no clone behind.
    if (!pushed) rmSync(workdir, { recursive: true, force: true });
  }
}
