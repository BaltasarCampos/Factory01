// `factory keygen` (contracts/cli.md, FR-016e): create the Owner key with a passphrase and set
// git to sign with it. Rotation (`--rotate`, `--finish`) ships with T145.
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ownerKeyPath, RECORD_NAMESPACE } from '../approvals/sign.js';
import type { CommandContext } from '../cli/commands.js';
import { ExitCode, RefusedError } from '../cli/env.js';

/** The `allowed_signers` line for a public key: principal `owner`, both signing namespaces. */
export function allowedSignersLine(publicKey: string): string {
  return `owner namespaces="${RECORD_NAMESPACE},git" ${publicKey.trim()}`;
}

function run(
  cmd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdinIsTerminal = false,
) {
  return spawnSync(cmd, args, {
    env,
    stdio: [stdinIsTerminal ? 'inherit' : 'ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

export function keygen(ctx: CommandContext): Promise<number> {
  if (ctx.options.rotate === true || ctx.options.finish === true)
    throw new RefusedError('factory keygen --rotate is not implemented in this build yet');

  const home = ctx.env.HOME ?? homedir();
  const key = ownerKeyPath(home);
  if (existsSync(key) || existsSync(`${key}.pub`))
    throw new RefusedError(
      `an Owner key already exists at ${key}; use factory keygen --rotate to replace it`,
    );
  mkdirSync(dirname(key), { recursive: true, mode: 0o700 });
  chmodSync(dirname(key), 0o700);

  ctx.io.stdout.write(
    'Choose a passphrase for the Owner key. It is required and asked for on every signature.\n',
  );
  // ssh-keygen asks for the passphrase itself, on the terminal; it never passes through here.
  const made = run(
    'ssh-keygen',
    ['-q', '-t', 'ed25519', '-C', 'factory-owner', '-f', key],
    ctx.env,
    true,
  );
  if (made.status !== 0) {
    rmSync(key, { force: true });
    rmSync(`${key}.pub`, { force: true });
    throw new RefusedError(`ssh-keygen failed: ${made.stderr.trim()}`);
  }
  // A key that opens with an empty passphrase has none: refuse it and keep nothing.
  const probeEnv = { ...ctx.env, SSH_ASKPASS_REQUIRE: 'never' };
  if (run('ssh-keygen', ['-y', '-P', '', '-f', key], probeEnv).status === 0) {
    rmSync(key, { force: true });
    rmSync(`${key}.pub`, { force: true });
    throw new RefusedError(
      'the Owner key needs a passphrase; nothing was kept, run factory keygen again',
    );
  }

  const publicKey = readFileSync(`${key}.pub`, 'utf8').trim();
  const line = allowedSignersLine(publicKey);
  const signers = join(home, '.factory', 'allowed_signers');
  const existing = existsSync(signers) ? readFileSync(signers, 'utf8') : '';
  if (!existing.split('\n').includes(line))
    appendFileSync(signers, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}${line}\n`);

  for (const [name, value] of [
    ['gpg.format', 'ssh'],
    ['user.signingkey', key],
    ['gpg.ssh.allowedSignersFile', signers],
  ] as const) {
    const set = run('git', ['config', '--global', name, value], ctx.env);
    if (set.status !== 0) throw new RefusedError(`git config ${name} failed: ${set.stderr.trim()}`);
  }

  ctx.io.stdout.write(
    [
      `Owner key created: ${key}`,
      '',
      'Public key:',
      `  ${publicKey}`,
      '',
      "allowed_signers line (add it to the factory release's allowed_signers):",
      `  ${line}`,
      '',
      'Set the cloud routine variable FACTORY_ALLOWED_SIGNERS to the same line.',
      `Git now signs with this key (gpg.format ssh, user.signingkey, gpg.ssh.allowedSignersFile ${signers}).`,
      '',
    ].join('\n'),
  );
  return Promise.resolve(ExitCode.Ok);
}
