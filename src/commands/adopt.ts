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
import { gitOut } from '../git/answers.js';
import { importsOutside, isClaudeMd, isHashed, outsideProtected } from '../install/manifest.js';
import {
  CONFIG_PATH,
  createDefineBranch,
  DEFINE_BRANCH,
  installProject,
} from '../install/project.js';
import { parseConfig, REPO } from '../model/config.js';
import { formatReleasePin } from '../model/naming.js';
import { visible } from '../notify/summary.js';
import {
  askConsent,
  commitAndPush,
  git,
  ownerHome,
  PITCH_PATH,
  startDefine,
  verifiedRelease,
} from './new.js';

const SYMLINK = '120000';
const GITLINK = '160000';

/**
 * Every session loads each `CLAUDE.md` and `CLAUDE.local.md` (T173), in any letter case: what the
 * Owner sees of those on main before consenting. Their text is untrusted, so every quoted line is
 * prefixed and goes through `visible()`; a symlink shows its target, which counts as an import;
 * each import outside the protected set is flagged, under a heading that gives their count. Any git
 * failure throws, never reading as no file, and a gitlink by those names refuses adopt.
 */
export function claudeMdShown(workdir: string, env: NodeJS.ProcessEnv): string {
  const git = (args: readonly string[]) => gitOut(workdir, args, env);
  const found = git(['ls-tree', '-r', '-z', 'HEAD'])
    .split('\0')
    .flatMap((entry) => {
      const tab = entry.indexOf('\t');
      const path = entry.slice(tab + 1);
      const [mode = '', , oid = ''] = entry.slice(0, tab).split(' ');
      return tab >= 0 && isClaudeMd(path) ? [{ path, mode, oid }] : [];
    });
  if (found.length === 0) return '';
  const out = ['Every agent session loads each CLAUDE.md and CLAUDE.local.md. On main now:'];
  const flagged: string[] = [];
  for (const { path, mode, oid } of found) {
    const name = visible(path);
    if (mode === GITLINK)
      throw new RefusedError(
        `${name} is a submodule; adopt needs each CLAUDE.md and CLAUDE.local.md to be a file`,
      );
    // Install removes or replaces what lies in a hashed folder, such as `.claude/`.
    const kept = !isHashed(path);
    out.push(
      '',
      `${name}: ${kept ? 'stays on main as it is' : "install replaces it with the release's files"}`,
    );
    const text = git(['cat-file', 'blob', oid]);
    if (mode === SYMLINK) {
      out.push(`  a symlink to ${visible(text)}`);
      if (kept && outsideProtected(path, text)) flagged.push(`${name} links to ${visible(text)}`);
      continue;
    }
    out.push(
      ...text
        .replace(/\n$/, '')
        .split('\n')
        .map((line) => `│ ${visible(line)}`),
    );
    if (kept)
      flagged.push(...importsOutside(path, text).map((t) => `${name} imports ${visible(t)}`));
  }
  const count = flagged.length === 0 ? 'none' : String(flagged.length);
  out.push(
    '',
    `Imports outside the protected set, which can change what every session reads: ${count}`,
    ...flagged.map((f) => `- ${f}`),
  );
  return out.join('\n');
}

export async function adopt(ctx: CommandContext): Promise<number> {
  const repo = ctx.positionals[0] ?? '';
  if (!REPO.test(repo)) throw new UsageError(`expected owner/repo, not ${JSON.stringify(repo)}`);
  const name = repo.slice(repo.indexOf('/') + 1);
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
    // A project made by `factory new` keeps its pitch on main.
    const pitch = git(workdir, ['show', `origin/main:${PITCH_PATH}`], ctx.env);
    return startDefine(ctx, config, workdir, pitch.ok ? pitch.out : undefined);
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
    else {
      const shown = claudeMdShown(workdir, ctx.env);
      if (shown !== '') ctx.io.stdout.write(`${shown}\n\n`);
    }

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
    return await startDefine(ctx, { repo, agents, factory_release: release.pin }, workdir);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    // Nothing reached main: leave no clone behind.
    if (!pushed) rmSync(workdir, { recursive: true, force: true });
  }
}
