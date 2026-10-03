import { chmodSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SigningError } from '../../src/approvals/sign.js';
import { signedCommit, signedMerge, signedTag, type GitSignOptions } from '../../src/git/sign.js';
import { gitEnv, makeRepo, runGit, type TestRepo } from '../helpers/git-repo.js';
import {
  makeKeys,
  makeOtherKeys,
  startAgent,
  tempDir,
  writeKeyFiles,
  type TestKeys,
} from '../helpers/keys.js';

function verifies(
  repo: TestRepo,
  keys: TestKeys,
  command: 'verify-commit' | 'verify-tag',
  ref: string,
): boolean {
  const { allowedSigners } = writeKeyFiles([keys]);
  try {
    runGit(repo.path, ['-c', `gpg.ssh.allowedSignersFile=${allowedSigners}`, command, ref]);
    return true;
  } catch {
    return false;
  }
}

function setup(): { repo: TestRepo; owner: TestKeys; options: GitSignOptions } {
  const owner = makeKeys();
  const repo = makeRepo({ files: { 'README.md': 'hello\n' } });
  return {
    repo,
    owner,
    options: { repo: repo.path, keyPath: owner.privateKey, stdinIsTTY: true, env: gitEnv },
  };
}

describe('git signing helpers (T147, research R18)', () => {
  it('signedCommit makes a commit that verifies with the Owner key and not another', () => {
    const { repo, owner, options } = setup();
    writeFileSync(join(repo.path, '.factory-config'), 'retry_limit: 4\n');
    repo.git(['add', '-A']);
    const sha = signedCommit(options, 'config: retry_limit 4');
    expect(repo.revParse('HEAD')).toBe(sha);
    expect(repo.git(['log', '-1', '--format=%s'])).toBe('config: retry_limit 4');
    expect(verifies(repo, owner, 'verify-commit', sha)).toBe(true);
    expect(verifies(repo, makeOtherKeys(), 'verify-commit', sha)).toBe(false);
  });

  it('signedCommit can make an empty root commit', () => {
    const owner = makeKeys();
    const repo = makeRepo();
    const sha = signedCommit(
      { repo: repo.path, keyPath: owner.privateKey, stdinIsTTY: true, env: gitEnv },
      'root',
      {
        allowEmpty: true,
      },
    );
    expect(repo.git(['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(verifies(repo, owner, 'verify-commit', sha)).toBe(true);
  });

  it('signedMerge makes a --no-ff merge commit of exactly the given commit', () => {
    const { repo, owner, options } = setup();
    const main = repo.revParse('HEAD');
    repo.checkout('claude/42-add-login', { create: true });
    const head = repo.commit({ 'src/login.ts': 'export {};\n' }, 'feat: login');
    repo.checkout('main');
    const merge = signedMerge(options, head, 'Merge #42 add login');
    expect(repo.git(['rev-list', '--parents', '-n', '1', merge]).split(' ')).toEqual([
      merge,
      main,
      head,
    ]);
    expect(verifies(repo, owner, 'verify-commit', merge)).toBe(true);
    expect(verifies(repo, makeOtherKeys(), 'verify-commit', merge)).toBe(false);
  });

  it('signedTag makes an annotated tag that verify-tag accepts with the Owner key only', () => {
    const { repo, owner, options } = setup();
    const target = repo.revParse('HEAD');
    signedTag(options, 'v1.0.0', target, 'factory v1.0.0');
    expect(repo.git(['rev-parse', 'v1.0.0^{commit}'])).toBe(target);
    expect(repo.git(['cat-file', '-t', 'v1.0.0'])).toBe('tag');
    expect(verifies(repo, owner, 'verify-tag', 'v1.0.0')).toBe(true);
    expect(verifies(repo, makeOtherKeys(), 'verify-tag', 'v1.0.0')).toBe(false);
  });

  it('refuses without a terminal for the passphrase and changes nothing', () => {
    const { repo, options } = setup();
    const before = repo.revParse('HEAD');
    const noTTY = { ...options, stdinIsTTY: false };
    expect(() => signedCommit(noTTY, 'x', { allowEmpty: true })).toThrow(/terminal/);
    expect(() => signedMerge(noTTY, before, 'x')).toThrow(SigningError);
    expect(() => {
      signedTag(noTTY, 'v1.0.0', before, 'x');
    }).toThrow(SigningError);
    expect(repo.revParse('HEAD')).toBe(before);
    expect(repo.git(['tag', '--list'])).toBe('');
  });

  it('never signs through an ssh-agent, even one holding the key', () => {
    const { repo, owner, options } = setup();
    const socket = startAgent(owner);
    renameSync(owner.privateKey, `${owner.privateKey}.moved`);
    const before = repo.revParse('HEAD');
    const withAgent = { ...options, env: { ...gitEnv, SSH_AUTH_SOCK: socket } };
    expect(() => signedCommit(withAgent, 'x', { allowEmpty: true })).toThrow(SigningError);
    expect(() => {
      signedTag(withAgent, 'v1.0.0', before, 'x');
    }).toThrow(SigningError);
    expect(repo.revParse('HEAD')).toBe(before);
    // git 2.39 leaves an unsigned tag behind when SSH signing fails; none may remain.
    expect(repo.git(['tag', '--list'])).toBe('');
  });

  it('leaves no merge in progress when signing a merge fails', () => {
    const { repo, owner, options } = setup();
    repo.checkout('feature', { create: true });
    const head = repo.commit({ 'a.txt': 'a\n' }, 'a');
    repo.checkout('main');
    const before = repo.revParse('HEAD');
    renameSync(owner.privateKey, `${owner.privateKey}.moved`);
    expect(() => signedMerge(options, head, 'merge')).toThrow(SigningError);
    expect(repo.revParse('HEAD')).toBe(before);
    expect(existsSync(join(repo.path, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(repo.git(['status', '--porcelain'])).toBe('');
  });

  it("ignores the repository's own signing program and hooks", () => {
    const { repo, owner, options } = setup();
    const marker = join(tempDir(), 'ran');
    const script = join(tempDir(), 'evil.sh');
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
    chmodSync(script, 0o755);
    repo.git(['config', 'gpg.ssh.program', script]);
    repo.git(['config', 'user.signingkey', makeOtherKeys().privateKey]);
    repo.git(['config', 'core.hooksPath', join(script, '..')]);
    writeFileSync(join(script, '..', 'pre-commit'), `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
    chmodSync(join(script, '..', 'pre-commit'), 0o755);
    const sha = signedCommit(options, 'x', { allowEmpty: true });
    expect(existsSync(marker)).toBe(false);
    repo.git(['config', '--unset', 'gpg.ssh.program']); // or it would run on verify too
    expect(verifies(repo, owner, 'verify-commit', sha)).toBe(true);
  });
});
