// Owner-signed git objects (research R18, R19): commits, merge commits and release tags signed
// with the Owner key under git's SSH signing (namespace `git`), the passphrase typed on the
// terminal, never through an ssh-agent.
import { spawnSync } from 'node:child_process';
import { assertPassphraseTerminal, signingEnv, SigningError } from '../approvals/sign.js';

export interface GitSignOptions {
  /** Working copy. */
  repo: string;
  keyPath: string;
  /** Whether stdin is a terminal; the passphrase prompt needs one. */
  stdinIsTTY: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Signing settings given on the command line, which beats the repository's own config: an
 * agent that edited `.git/config` cannot swap the key or the signing program, or run a hook
 * while the Owner is typing the passphrase.
 */
function signingConfig(keyPath: string): string[] {
  return [
    ...['-c', 'gpg.format=ssh'],
    ...['-c', `user.signingkey=${keyPath}`],
    ...['-c', 'gpg.ssh.program=ssh-keygen'],
    ...['-c', 'core.hooksPath=/dev/null'],
  ];
}

function git(
  options: GitSignOptions,
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', [...signingConfig(options.keyPath), ...args], {
    cwd: options.repo,
    env: signingEnv(options.env ?? process.env),
    // stdin stays the terminal: ssh-keygen prompts there for the passphrase.
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.error) throw new SigningError(`could not run git: ${result.error.message}`);
  return result;
}

function signed(options: GitSignOptions, what: string, args: readonly string[]): void {
  assertPassphraseTerminal(options.stdinIsTTY);
  const result = git(options, args);
  if (result.status !== 0) throw new SigningError(`${what} failed: ${result.stderr.trim()}`);
}

function head(options: GitSignOptions): string {
  return git(options, ['rev-parse', 'HEAD']).stdout.trim();
}

/** Commit what is staged as an Owner-signed commit; returns its sha. */
export function signedCommit(
  options: GitSignOptions,
  message: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): string {
  signed(options, 'signed commit', [
    'commit',
    '-q',
    '-S',
    '-m',
    message,
    ...(allowEmpty ? ['--allow-empty'] : []),
  ]);
  return head(options);
}

/** `git merge --no-ff -S` of exactly `commit` into the current branch; returns the merge sha. */
export function signedMerge(options: GitSignOptions, commit: string, message: string): string {
  assertPassphraseTerminal(options.stdinIsTTY);
  try {
    signed(options, 'signed merge', ['merge', '-q', '--no-ff', '-S', '-m', message, commit]);
  } catch (err) {
    git(options, ['merge', '--abort']);
    throw err;
  }
  return head(options);
}

/** An annotated, Owner-signed tag on `target`. */
export function signedTag(
  options: GitSignOptions,
  tag: string,
  target: string,
  message: string,
): void {
  signed(options, 'signed tag', ['tag', '-s', '-m', message, tag, target]);
  // git 2.39 reports a failed SSH signature but still creates the tag, unsigned, and exits 0.
  const object = git(options, ['cat-file', 'tag', `refs/tags/${tag}`]).stdout;
  if (!object.includes('-----BEGIN SSH SIGNATURE-----')) {
    git(options, ['tag', '-d', tag]);
    throw new SigningError(`signed tag failed: git created ${tag} without a signature`);
  }
}
