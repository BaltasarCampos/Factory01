import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/commands.js';
import { ExitCode } from '../../src/cli/env.js';
import { tempDir } from '../helpers/keys.js';

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  home: string;
  gitConfig: string;
}

/** `factory keygen` on a "laptop" with a fresh HOME; the passphrase comes from an askpass script. */
async function keygen(passphrase: string, args: string[] = [], home = tempDir()): Promise<Run> {
  const askpass = join(tempDir(), 'askpass.sh');
  writeFileSync(askpass, `#!/bin/sh\nprintf '%s\\n' '${passphrase}'\n`);
  chmodSync(askpass, 0o755);
  const gitConfig = join(home, '.gitconfig');
  let stdout = '';
  let stderr = '';
  const code = await runCli(['keygen', ...args], {
    stdout: { write: (s) => (stdout += s) },
    stderr: { write: (s) => (stderr += s) },
    env: {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: 'force',
    },
    stdinIsTTY: true,
    unreadAlerts: () => Promise.resolve([]),
  });
  return { code, stdout, stderr, home, gitConfig };
}

function gitConfigValue(file: string, key: string): string {
  return execFileSync('git', ['config', '--file', file, key], { encoding: 'utf8' }).trim();
}

describe('factory keygen (T032)', () => {
  it('creates a passphrase-protected Owner key, configures git signing and prints the signer line', async () => {
    const run = await keygen('correct horse battery');
    expect(run.stderr).toBe('');
    expect(run.code).toBe(ExitCode.Ok);

    const key = join(run.home, '.factory', 'keys', 'approve_ed25519');
    const pub = readFileSync(`${key}.pub`, 'utf8').trim();
    expect(pub).toMatch(/^ssh-ed25519 \S+ /);
    expect(statSync(join(run.home, '.factory', 'keys')).mode & 0o777).toBe(0o700);
    // An empty passphrase does not open the key.
    expect(
      spawnSync('ssh-keygen', ['-y', '-P', '', '-f', key], { stdio: 'ignore' }).status,
    ).not.toBe(0);

    const line = `owner namespaces="factory-approve,git" ${pub}`;
    expect(run.stdout).toContain(pub);
    expect(run.stdout).toContain(line);
    expect(run.stdout).toContain('FACTORY_ALLOWED_SIGNERS');

    const signers = join(run.home, '.factory', 'allowed_signers');
    expect(readFileSync(signers, 'utf8')).toBe(`${line}\n`);
    expect(gitConfigValue(run.gitConfig, 'gpg.format')).toBe('ssh');
    expect(gitConfigValue(run.gitConfig, 'user.signingkey')).toBe(key);
    expect(gitConfigValue(run.gitConfig, 'gpg.ssh.allowedSignersFile')).toBe(signers);
  });

  it('refuses an empty passphrase and keeps nothing', async () => {
    const run = await keygen('');
    expect(run.code).toBe(ExitCode.Refused);
    expect(run.stderr).toMatch(/passphrase/);
    expect(existsSync(join(run.home, '.factory', 'keys', 'approve_ed25519'))).toBe(false);
    expect(existsSync(join(run.home, '.factory', 'keys', 'approve_ed25519.pub'))).toBe(false);
    expect(existsSync(run.gitConfig)).toBe(false);
  });

  it('refuses to replace an existing key', async () => {
    const home = tempDir();
    mkdirSync(join(home, '.factory', 'keys'), { recursive: true });
    writeFileSync(join(home, '.factory', 'keys', 'approve_ed25519'), 'existing');
    const run = await keygen('correct horse battery', [], home);
    expect(run.code).toBe(ExitCode.Refused);
    expect(run.stderr).toMatch(/already exists.*--rotate/);
    expect(readFileSync(join(home, '.factory', 'keys', 'approve_ed25519'), 'utf8')).toBe(
      'existing',
    );
  });

  it('keeps allowed_signers entries already on the laptop', async () => {
    const home = tempDir();
    mkdirSync(join(home, '.factory'), { recursive: true });
    writeFileSync(join(home, '.factory', 'allowed_signers'), 'owner ssh-ed25519 AAAAold old\n');
    const run = await keygen('correct horse battery', [], home);
    expect(run.code).toBe(ExitCode.Ok);
    const lines = readFileSync(join(home, '.factory', 'allowed_signers'), 'utf8').split('\n');
    expect(lines[0]).toBe('owner ssh-ed25519 AAAAold old');
    expect(lines[1]).toMatch(/^owner namespaces="factory-approve,git" ssh-ed25519 /);
  });

  it('refuses --rotate until key rotation ships', async () => {
    const run = await keygen('correct horse battery', ['--rotate']);
    expect(run.code).toBe(ExitCode.Refused);
    expect(run.stderr).toMatch(/--rotate/);
  });
});
