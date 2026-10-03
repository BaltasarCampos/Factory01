// Owner signatures over approval records (research R4, FR-016e): `ssh-keygen -Y sign` run on
// the key file itself, the passphrase typed on the terminal, never through an ssh-agent.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RefusedError } from '../cli/env.js';
import type { ApprovalRecord } from '../model/types.js';
import { serialise, type SignedText } from './record.js';

export const RECORD_NAMESPACE = 'factory-approve';

/** `~/.factory/keys/approve_ed25519`: the Owner key, laptop only. */
export function ownerKeyPath(home: string): string {
  return join(home, '.factory', 'keys', 'approve_ed25519');
}

export class SigningError extends RefusedError {}

export interface SignOptions {
  /** Whether stdin is a terminal; the passphrase prompt needs one. */
  stdinIsTTY: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Environment for any Owner signature: no agent socket, so an unlocked key cannot be used,
 * and no askpass program, so the passphrase is read from the terminal only.
 */
export function signingEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, SSH_ASKPASS_REQUIRE: 'never' };
  delete out.SSH_AUTH_SOCK;
  delete out.SSH_ASKPASS;
  return out;
}

export function assertPassphraseTerminal(stdinIsTTY: boolean): void {
  if (!stdinIsTTY)
    throw new SigningError('signing refused: the key passphrase needs a terminal on stdin');
}

/** Sign a record's canonical bytes under namespace `factory-approve`. */
export function sign(record: ApprovalRecord, keyPath: string, options: SignOptions): SignedText {
  const text = serialise(record);
  assertPassphraseTerminal(options.stdinIsTTY);
  const dir = mkdtempSync(join(tmpdir(), 'factory-sign-'));
  try {
    const file = join(dir, 'record');
    writeFileSync(file, text, { mode: 0o600 });
    // stdin stays the terminal: ssh-keygen prompts there for the passphrase.
    const result = spawnSync(
      'ssh-keygen',
      ['-Y', 'sign', '-n', RECORD_NAMESPACE, '-f', keyPath, file],
      {
        env: signingEnv(options.env ?? process.env),
        stdio: ['inherit', 'ignore', 'pipe'],
        encoding: 'utf8',
      },
    );
    if (result.error) throw new SigningError(`could not run ssh-keygen: ${result.error.message}`);
    if (result.status !== 0)
      throw new SigningError(`signing with ${keyPath} failed: ${result.stderr.trim()}`);
    return { text, signature: readFileSync(`${file}.sig`, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
