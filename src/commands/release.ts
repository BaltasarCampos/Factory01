// `factory release <tag>` (contracts/cli.md, FR-007e): on the laptop, in the factory
// repository, show what changed since the last signed release, and on the Owner's confirmation
// sign a tag whose message is the guardrail manifest of the release commit, then push it. CI
// never creates or signs release tags.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseKeys } from '../approvals/keys.js';
import { ownerKeyPath } from '../approvals/sign.js';
import type { CommandContext } from '../cli/commands.js';
import { EnvironmentError, ExitCode, RefusedError, UsageError } from '../cli/env.js';
import { signedTag } from '../git/sign.js';
import { buildManifest, serialiseManifest } from '../install/manifest.js';
import { render } from '../install/render.js';
import { formatReleasePin } from '../model/naming.js';
import { lastSignedTag, RELEASE_TAG, ReleaseTagError, verifyReleaseTag } from '../release/tag.js';

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  if (result.error) throw new EnvironmentError(`could not run git: ${result.error.message}`);
  return { ok: result.status === 0, out: result.stdout.trimEnd(), err: result.stderr.trim() };
}

const SAFE_DIFF = ['--no-ext-diff', '--no-textconv', '--no-renames'];

export async function release(ctx: CommandContext): Promise<number> {
  const tag = ctx.positionals[0] ?? '';
  if (!RELEASE_TAG.test(tag)) throw new UsageError(`release tags look like v1.2.3, not ${tag}`);
  const run = (args: readonly string[]) => git(ctx.cwd, args, ctx.env);

  const top = run(['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new RefusedError('factory release runs in a clone of the factory repository');
  const root = top.out;
  const repoGit = (args: readonly string[]) => git(root, args, ctx.env);
  const head = repoGit(['rev-parse', 'HEAD']).out;
  const isFactory =
    existsSync(join(root, 'factory')) &&
    ['allowed_signers', 'revoked_keys'].every((f) => repoGit(['cat-file', '-e', `HEAD:${f}`]).ok);
  if (!isFactory)
    throw new RefusedError(
      'factory release runs in the factory repository (factory/, allowed_signers and ' +
        'revoked_keys committed at HEAD)',
    );
  if (repoGit(['status', '--porcelain']).out !== '')
    throw new RefusedError('the work tree has uncommitted changes; a release is a commit');
  if (repoGit(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).ok)
    throw new RefusedError(`tag ${tag} already exists`);

  const scratch = mkdtempSync(join(tmpdir(), 'factory-release-'));
  try {
    const keys = releaseKeys(root, head, scratch);
    const last = lastSignedTag(root, head, keys);
    const range = last === undefined ? head : `${last.sha}..${head}`;
    ctx.io.stdout.write(
      last === undefined
        ? `No signed release yet: ${tag} releases the whole tree at ${head}.\n`
        : `Changes since ${last.tag} (${last.sha.slice(0, 12)}):\n\n` +
            `${repoGit(['log', '--oneline', '--no-decorate', range]).out}\n\n` +
            `${repoGit(['diff', '--stat', ...SAFE_DIFF, last.sha, head]).out}\n`,
    );

    const tree = join(scratch, 'tree');
    render(join(root, 'factory'), tree, {});
    const manifest = buildManifest(tree, { tag, sha: head });
    const count = Object.keys(manifest.files).length;
    ctx.io.stdout.write(`\nGuardrail manifest: ${String(count)} protected files.\n`);

    const answer = await ctx.ask(`Type ${tag} to sign it at ${head} and push it: `);
    if (answer.trim() !== tag) {
      ctx.io.stdout.write('Not released; nothing was created.\n');
      return ExitCode.Refused;
    }

    const home = ctx.env.HOME ?? homedir();
    const signing = { repo: root, keyPath: ownerKeyPath(home), stdinIsTTY: ctx.stdinIsTTY };
    signedTag({ ...signing, env: ctx.env }, tag, head, serialiseManifest(manifest));
    try {
      verifyReleaseTag(root, tag, head, keys);
    } catch (err) {
      repoGit(['tag', '-d', tag]);
      const why = err instanceof ReleaseTagError ? err.message : String(err);
      throw new RefusedError(
        `${why}\nThe tag was deleted. Add your key to allowed_signers in a signed commit first.`,
      );
    }
    const push = repoGit(['push', '-q', 'origin', `refs/tags/${tag}`]);
    if (!push.ok)
      throw new RefusedError(
        `signed ${tag} locally, but the push failed: ${push.err}\n` +
          `Retry with: git push origin refs/tags/${tag}`,
      );
    ctx.io.stdout.write(`Released ${formatReleasePin({ tag, sha: head })}.\n`);
    return ExitCode.Ok;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
