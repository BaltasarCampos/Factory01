// Throwaway Owner keys made with the real `ssh-keygen`, so signature tests exercise the same
// verification the factory uses. Keys have no passphrase and never touch ~/.factory.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';

export interface TestKeys {
  /** Directory holding the key pair. */
  dir: string;
  /** Path to the private key (pass to `ssh-keygen -Y sign -f` or `user.signingkey`). */
  privateKey: string;
  /** Path to the `.pub` file. */
  publicKeyPath: string;
  /** Public key line, `ssh-ed25519 AAAA… comment`. */
  publicKey: string;
  /** `owner namespaces="factory-approve,git" <pubkey>` */
  allowedSignersLine: string;
}

export interface KeyFiles {
  allowedSigners: string;
  revokedKeys: string;
}

const pendingCleanup = new Set<string>();
process.once('exit', () => {
  for (const dir of pendingCleanup) rmSync(dir, { recursive: true, force: true });
});

/**
 * A temp directory removed when the current test ends, or at process exit when created
 * outside a test (for example in `beforeAll`).
 */
export function tempDir(prefix = 'factory-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    onTestFinished(() => {
      rmSync(dir, { recursive: true, force: true });
    });
  } catch {
    pendingCleanup.add(dir);
  }
  return dir;
}

function generate(comment: string): TestKeys {
  const dir = tempDir('factory-keys-');
  const privateKey = join(dir, 'id_ed25519');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', privateKey], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const publicKeyPath = `${privateKey}.pub`;
  const publicKey = readFileSync(publicKeyPath, 'utf8').trim();
  return {
    dir,
    privateKey,
    publicKeyPath,
    publicKey,
    allowedSignersLine: `owner namespaces="factory-approve,git" ${publicKey}`,
  };
}

/** The Owner's test key. */
export function makeKeys(): TestKeys {
  return generate('factory-test-owner');
}

/** An unrelated key, for signature-mismatch and forged-record cases. */
export function makeOtherKeys(): TestKeys {
  return generate('factory-test-other');
}

/**
 * Write `allowed_signers` (keys in the given order, oldest first) and `revoked_keys` (public
 * keys, one per line; empty file when none) into a fresh temp directory.
 */
export function writeKeyFiles(
  keys: readonly TestKeys[],
  revoked: readonly TestKeys[] = [],
): KeyFiles {
  const dir = tempDir('factory-signers-');
  const allowedSigners = join(dir, 'allowed_signers');
  const revokedKeys = join(dir, 'revoked_keys');
  writeFileSync(allowedSigners, keys.map((k) => `${k.allowedSignersLine}\n`).join(''));
  writeFileSync(revokedKeys, revoked.map((k) => `${k.publicKey}\n`).join(''));
  return { allowedSigners, revokedKeys };
}
