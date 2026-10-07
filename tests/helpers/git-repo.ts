// Temp git repositories with a bare `origin`, isolated from the developer's git config.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir, type TestKeys } from './keys.js';

/** File contents keyed by repo-relative path; `null` deletes the file. */
export type Files = Record<string, string | null>;

export interface CommitOptions {
  /** Sign the commit with this key (git SSH signing, no agent). */
  signWith?: TestKeys;
  /** Extra commit-message trailers, e.g. `{ 'Factory-Role': 'builder' }`. */
  trailers?: Record<string, string>;
  /** Allow a commit with no changes. */
  allowEmpty?: boolean;
}

export interface TestRepo {
  /** Working copy. */
  path: string;
  /** Bare repository acting as `origin`. */
  origin: string;
  /** Run git in the working copy and return trimmed stdout. */
  git(args: readonly string[]): string;
  /** Write the files, stage everything, commit; returns the new commit SHA. */
  commit(files: Files, message: string, options?: CommitOptions): string;
  /** Check out a branch, creating it from HEAD when `create` is set. */
  checkout(branch: string, options?: { create?: boolean }): void;
  /** `git rev-parse <ref>`. */
  revParse(ref: string): string;
  /** Push a branch (default: the current one) to origin. */
  push(branch?: string, options?: { force?: boolean }): void;
}

export interface MakeRepoOptions {
  /** Initial branch name (default `main`). */
  branch?: string;
  /** Files for an initial commit; no commit is made when omitted. */
  files?: Files;
  /** Sign the initial commit. */
  signWith?: TestKeys;
}

/** Environment that hides the user's global and system git config. */
export const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Factory Test',
  GIT_AUTHOR_EMAIL: 'test@factory.invalid',
  GIT_COMMITTER_NAME: 'Factory Test',
  GIT_COMMITTER_EMAIL: 'test@factory.invalid',
  GIT_TERMINAL_PROMPT: '0',
};

export function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function writeFiles(root: string, files: Files): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    if (content === null) {
      rmSync(full, { force: true });
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
}

export function makeRepo(options: MakeRepoOptions = {}): TestRepo {
  const branch = options.branch ?? 'main';
  const root = tempDir('factory-repo-');
  const origin = join(root, 'origin.git');
  const path = join(root, 'work');

  runGit(root, ['init', '-q', '--bare', `--initial-branch=${branch}`, origin]);
  runGit(root, ['init', '-q', `--initial-branch=${branch}`, path]);
  runGit(path, ['remote', 'add', 'origin', origin]);

  const repo: TestRepo = {
    path,
    origin,
    git: (args) => runGit(path, args),
    commit(files, message, commitOptions = {}) {
      writeFiles(path, files);
      runGit(path, ['add', '-A']);
      const args = ['commit', '-q', '-m', message];
      for (const [key, value] of Object.entries(commitOptions.trailers ?? {})) {
        args.push('--trailer', `${key}: ${value}`);
      }
      if (commitOptions.allowEmpty) args.push('--allow-empty');
      if (commitOptions.signWith) {
        args.unshift(
          '-c',
          'gpg.format=ssh',
          '-c',
          `user.signingkey=${commitOptions.signWith.privateKey}`,
        );
        args.push('-S');
      } else {
        args.push('--no-gpg-sign');
      }
      runGit(path, args);
      return runGit(path, ['rev-parse', 'HEAD']);
    },
    checkout(name, checkoutOptions = {}) {
      runGit(
        path,
        checkoutOptions.create ? ['checkout', '-q', '-b', name] : ['checkout', '-q', name],
      );
    },
    revParse: (ref) => runGit(path, ['rev-parse', ref]),
    push(name, pushOptions = {}) {
      const target = name ?? runGit(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
      runGit(path, ['push', '-q', ...(pushOptions.force ? ['-f'] : []), 'origin', target]);
    },
  };

  if (options.files) {
    repo.commit(
      options.files,
      'initial commit',
      options.signWith ? { signWith: options.signWith } : {},
    );
    repo.push(branch);
  }
  return repo;
}

/**
 * `git merge --no-ff` of `branch` into main, signed with `signWith` when given, with a
 * `Factory-Merge: <trailer>` line as `factory merge` writes it; main is pushed.
 */
export function mergeIntoMain(
  repo: TestRepo,
  branch: string,
  trailer: string,
  options: { signWith?: TestKeys } = {},
): string {
  repo.checkout('main');
  const sign = options.signWith
    ? ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${options.signWith.privateKey}`]
    : [];
  const message = `Merge ${branch}\n\nFactory-Merge: ${trailer}`;
  repo.git([
    ...sign,
    'merge',
    '-q',
    '--no-ff',
    options.signWith ? '-S' : '--no-gpg-sign',
    '-m',
    message,
    branch,
  ]);
  repo.push('main');
  return repo.revParse('HEAD');
}

/** A Define branch with a brief, merged into main by `mergeIntoMain`. */
export function mergeBrief(repo: TestRepo, options: { signWith?: TestKeys } = {}): string {
  repo.checkout('claude/define', { create: true });
  repo.commit({ '.factory/brief.md': '# Brief\n' }, 'Define: brief');
  return mergeIntoMain(repo, 'claude/define', 'define', options);
}
