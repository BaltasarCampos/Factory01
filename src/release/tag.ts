// Signed factory release tags (research R19, FR-006, AC-083). A release is an annotated tag
// signed with an Owner key under git's SSH signing (namespace `git`). Projects pin it as
// `<tag>@<sha>`, so a tag is accepted only while it still names that commit.
import { spawnSync } from 'node:child_process';
import type { ReleaseKeys } from '../approvals/keys.js';
import { EnvironmentError, RefusedError } from '../cli/env.js';
import { parseManifest } from '../install/manifest.js';
import type { GuardrailManifest, ReleasePin } from '../model/types.js';

export const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

export class ReleaseTagError extends RefusedError {}

function git(repo: string, args: readonly string[]): { ok: boolean; out: string; err: string } {
  // Hooks off: verifying a tag must not run anything from the repository.
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (result.error) throw new EnvironmentError(`could not run git: ${result.error.message}`);
  return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr.trim() };
}

/**
 * Refuse unless `refs/tags/<tag>` is an annotated tag object named `<tag>`, pointing at commit
 * `sha`, whose SSH signature `git verify-tag` accepts with `keys` (an `allowed_signers` holding
 * every key the Owner has used, and the revoked ones). The decision is git's exit code.
 */
export function verifyReleaseTag(repo: string, tag: string, sha: string, keys: ReleaseKeys): void {
  if (!RELEASE_TAG.test(tag)) throw new ReleaseTagError(`invalid release tag ${tag}`);
  const ref = `refs/tags/${tag}`;
  const type = git(repo, ['cat-file', '-t', ref]);
  if (!type.ok) throw new ReleaseTagError(`release tag ${tag} does not exist`);
  if (type.out !== 'tag') throw new ReleaseTagError(`${tag} is a lightweight tag, not signed`);

  const object = git(repo, ['cat-file', 'tag', ref]).out;
  const header = object.split('\n\n')[0]?.split('\n') ?? [];
  if (!header.includes(`tag ${tag}`))
    throw new ReleaseTagError(`${ref} holds a tag object made for another tag name`);
  if (!header.includes('type commit') || !header.includes(`object ${sha}`))
    throw new ReleaseTagError(`${tag} does not point at the pinned commit ${sha}; it was moved`);
  if (!object.includes('-----BEGIN SSH SIGNATURE-----'))
    throw new ReleaseTagError(`${tag} is not signed`);

  const verify = git(repo, [
    ...['-c', 'gpg.format=ssh'],
    ...['-c', 'gpg.ssh.program=ssh-keygen'],
    ...['-c', `gpg.ssh.allowedSignersFile=${keys.allowedSigners}`],
    ...['-c', `gpg.ssh.revocationFile=${keys.revokedKeys}`],
    'verify-tag',
    ref,
  ]);
  if (!verify.ok)
    throw new ReleaseTagError(
      `${tag} is not signed by a listed, non-revoked Owner key: ${verify.err.split('\n').at(-1) ?? ''}`,
    );
}

/** The newest release tag reachable from `head` that verifies with `keys`, if any. */
export function lastSignedTag(
  repo: string,
  head: string,
  keys: ReleaseKeys,
): ReleasePin | undefined {
  const tags = git(repo, ['tag', '--merged', head, '--list', 'v*', '--sort=-v:refname']).out;
  for (const tag of tags.split('\n').filter((t) => RELEASE_TAG.test(t))) {
    const sha = git(repo, ['rev-parse', `refs/tags/${tag}^{commit}`]).out;
    try {
      verifyReleaseTag(repo, tag, sha, keys);
      return { tag, sha };
    } catch (err) {
      if (!(err instanceof ReleaseTagError)) throw err;
    }
  }
  return undefined;
}

/**
 * The guardrail manifest of the pinned release, read from its tag only after `verifyReleaseTag`
 * accepts the tag with `keys`: the hashes are trusted because the Owner signed them.
 */
export function verifiedManifest(
  repo: string,
  pin: ReleasePin,
  keys: ReleaseKeys,
): GuardrailManifest {
  verifyReleaseTag(repo, pin.tag, pin.sha, keys);
  const object = git(repo, ['cat-file', 'tag', `refs/tags/${pin.tag}`]).out;
  const manifest = parseManifest(object.slice(object.indexOf('\n\n') + 2));
  if (manifest.release !== pin.tag || manifest.commit !== pin.sha)
    throw new ReleaseTagError(`the manifest in ${pin.tag} is not for ${pin.tag}@${pin.sha}`);
  return manifest;
}
