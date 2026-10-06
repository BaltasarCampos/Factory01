// `factory new "<pitch>" [--name <repo>]` (contracts/cli.md, FR-003, FR-004): verify the newest
// factory release with the laptop's key list, ask where agents may run before anything is
// created, then create an empty private repo, install the release into it, push an
// Owner-signed root commit and start Define. The helpers are shared with `factory adopt`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { factorySource, laptopKeys } from '../approvals/keys.js';
import { assertPassphraseTerminal, ownerKeyPath } from '../approvals/sign.js';
import type { CommandContext } from '../cli/commands.js';
import { EnvironmentError, ExitCode, RefusedError, UsageError } from '../cli/env.js';
import { selectLauncher } from '../dispatcher/launcher/select.js';
import { signedCommit } from '../git/sign.js';
import { Fields, gh } from '../github/gh.js';
import { cloneRepo, createRepo } from '../github/repo.js';
import { createDefineBranch, DEFINE_BRANCH, installProject } from '../install/project.js';
import { formatReleasePin, slugify } from '../model/naming.js';
import type { AgentsMode, ProjectConfig, ReleasePin } from '../model/types.js';
import { RELEASE_TAG, verifyReleaseTag } from '../release/tag.js';

export const CONSENT = `Before anything is created, choose where agents may run:

  cloud  Claude Code cloud sessions. Agents clone this project's code into
         provider-managed cloud VMs through the Claude GitHub App.
  local  Sessions run only on this laptop; the code stays here and on GitHub.

The choice is saved as \`agents:\` in .factory/config.
`;

export function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  if (result.error) throw new EnvironmentError(`could not run git: ${result.error.message}`);
  return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr.trim() };
}

function mustGit(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  const result = git(cwd, args, env);
  if (!result.ok) throw new RefusedError(`git ${args.join(' ')} failed: ${result.err}`);
  return result.out;
}

/** The laptop's home, once the Owner key and a terminal for its passphrase are there. */
export function ownerHome(ctx: CommandContext): string {
  assertPassphraseTerminal(ctx.stdinIsTTY);
  const home = ctx.env.HOME ?? homedir();
  if (!existsSync(ownerKeyPath(home)))
    throw new RefusedError(`${ownerKeyPath(home)} not found; run factory keygen first`);
  return home;
}

export interface Release {
  factoryRepo: string;
  pin: ReleasePin;
  /** The release's `factory/` material, extracted from the pinned commit. */
  factoryRoot: string;
}

/**
 * The newest release tag of the factory clone, verified with the laptop's key list (no project
 * pin exists yet), with its `factory/` directory extracted into `scratch`.
 */
export function verifiedRelease(env: NodeJS.ProcessEnv, home: string, scratch: string): Release {
  const source = factorySource(env);
  const url = git(source, ['remote', 'get-url', 'origin'], env).out;
  const repo = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1];
  if (repo === undefined)
    throw new RefusedError(`${source}: origin ${url} is not the factory repository on GitHub`);
  const tags = git(source, ['tag', '--list', 'v*', '--sort=-v:refname'], env).out.split('\n');
  const tag = tags.find((t) => RELEASE_TAG.test(t));
  if (tag === undefined)
    throw new RefusedError(`${source} has no factory release; run factory release first`);
  const sha = mustGit(source, ['rev-parse', `refs/tags/${tag}^{commit}`], env);
  verifyReleaseTag(source, tag, sha, laptopKeys(home));

  const archive = spawnSync('git', ['archive', '--format=tar', sha, 'factory'], {
    cwd: source,
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (archive.status !== 0) throw new RefusedError(`release ${tag} has no factory/ directory`);
  const untar = spawnSync('tar', ['-x', '-C', scratch], { input: archive.stdout });
  if (untar.status !== 0) throw new EnvironmentError(`could not extract release ${tag}`);
  return { factoryRepo: repo, pin: { tag, sha }, factoryRoot: join(scratch, 'factory') };
}

/** Print the consent text and ask; `undefined` unless the Owner answers cloud or local. */
export async function askConsent(ctx: CommandContext): Promise<AgentsMode | undefined> {
  ctx.io.stdout.write(CONSENT);
  const answer = (await ctx.ask('Agents run in the cloud or local only? [cloud/local] '))
    .trim()
    .toLowerCase();
  return answer === 'cloud' || answer === 'local' ? answer : undefined;
}

const GUARDED = ['.claude', '.github/workflows', '.specify', '.mcp.json', '.factory'];

/** Commit the work tree as an Owner-signed commit on main and push it. */
export function commitAndPush(
  ctx: CommandContext,
  home: string,
  workdir: string,
  message: string,
): void {
  mustGit(workdir, ['add', '-A'], ctx.env);
  // A project `.gitignore` must not keep a guardrail file off main.
  const present = GUARDED.filter((path) => existsSync(join(workdir, path)));
  mustGit(workdir, ['add', '-f', '--', ...present], ctx.env);
  const signing = { repo: workdir, keyPath: ownerKeyPath(home), stdinIsTTY: ctx.stdinIsTTY };
  signedCommit({ ...signing, env: ctx.env }, message);
  mustGit(workdir, ['push', '-q', 'origin', 'refs/heads/main'], ctx.env);
}

/**
 * Start Station 0 on `claude/define` with the launcher of the project's `agents:` choice. Until
 * the release ships its Station 0 prompt (T046), the prompt is written here.
 */
export async function startDefine(
  ctx: CommandContext,
  config: Pick<ProjectConfig, 'repo' | 'agents'>,
  input: string,
): Promise<number> {
  const prompt = [
    `Station 0 (Define) for ${config.repo}. Work only on branch ${DEFINE_BRANCH}; open one ` +
      'draft pull request for the Owner.',
    input,
    'First ask the Owner up to 5 questions in one batch in .factory/define/questions.md.',
  ].join('\n\n');
  try {
    const launcher = selectLauncher(config, ctx.launchers);
    if (!(await launcher.available()))
      throw new RefusedError(`the ${launcher.mode} launcher is not available`);
    // Define works for the project, not for a work item.
    const request = { role: 'define', station: 0, item: 0, branch: DEFINE_BRANCH, prompt } as const;
    const { sessionId } = await launcher.launch(request);
    ctx.io.stdout.write(`Define started on ${DEFINE_BRANCH} (${launcher.mode}, ${sessionId}).\n`);
    return ExitCode.Ok;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    ctx.io.stderr.write(
      `Define was not started: ${why}\n` +
        `The project is installed; run \`factory adopt ${config.repo}\` here to start Define.\n`,
    );
    return ExitCode.Refused;
  }
}

export async function newProject(ctx: CommandContext): Promise<number> {
  const pitch = (ctx.positionals[0] ?? '').trim();
  if (pitch === '') throw new UsageError('the pitch is empty');
  const name = typeof ctx.options.name === 'string' ? ctx.options.name : slugify(pitch);
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name))
    throw new UsageError(`invalid repository name ${JSON.stringify(name)}`);
  const workdir = join(ctx.cwd, name);
  if (existsSync(workdir)) throw new RefusedError(`${workdir} already exists`);
  const home = ownerHome(ctx);

  const scratch = mkdtempSync(join(tmpdir(), 'factory-new-'));
  try {
    const release = verifiedRelease(ctx.env, home, scratch);
    const agents = await askConsent(ctx);
    if (agents === undefined) {
      ctx.io.stdout.write('No choice made; nothing was created.\n');
      return ExitCode.Refused;
    }
    const options = { env: ctx.env };
    const login = Fields.of(await gh(['api', 'user'], { ...options, json: true }), 'user');
    const repo = await createRepo(`${login.str('login')}/${name}`, options);
    await cloneRepo(repo, workdir, options);
    // The repo is empty: no auto-generated commit, so main starts at the signed root commit.
    mustGit(workdir, ['symbolic-ref', 'HEAD', 'refs/heads/main'], ctx.env);
    await installProject({ repo, workdir, ...release, agents, ...options });
    mkdirSync(join(workdir, '.factory', 'define'), { recursive: true });
    writeFileSync(join(workdir, '.factory', 'define', 'pitch.md'), `${pitch}\n`);
    const pin = formatReleasePin(release.pin);
    commitAndPush(ctx, home, workdir, `factory new: ${repo}\n\nFactory release ${pin}.`);
    createDefineBranch(workdir, ctx.env);
    ctx.io.stdout.write(`Created ${repo} (private) in ${workdir}, pinned to ${pin}.\n`);
    return await startDefine(
      ctx,
      { repo, agents },
      "The Owner's pitch is in .factory/define/pitch.md.",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
