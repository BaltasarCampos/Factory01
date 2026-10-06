// Owner key lists (data-model.md § Keys and rotation, contracts/approval-record.md step 3).
//
// Records are verified with the `allowed_signers` and `revoked_keys` of the factory release
// pinned on main, never a pull request's copy. A second copy of the newest key, held where no
// agent can write it, must agree with that list; a mismatch right after an upgrade added a key
// is a pending rotation rather than tampering.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOUD_MARKER, RefusedError } from '../cli/env.js';
import { parseConfig } from '../model/config.js';
import type { ReleasePin } from '../model/types.js';
import { ownerKeyPath } from './sign.js';

/** Routine variable holding the newest key in the cloud (set by the Owner at claude.ai). */
export const SECOND_COPY_VAR = 'FACTORY_ALLOWED_SIGNERS';

/** Main's pinned key files, as passed to `ssh-keygen -Y verify -f … -r …`. */
export interface ReleaseKeys {
  allowedSigners: string;
  revokedKeys: string;
}

export type KeyCheck =
  | { status: 'ok' }
  | { status: 'rotation-pending'; reason: string }
  | { status: 'tampering'; reason: string };

export class KeyError extends RefusedError {}

/**
 * `<type> <base64>` of a public key, from a `.pub` line, an `allowed_signers` line (principal
 * and options first) or a bare key; comments and extra whitespace are dropped.
 */
export function keyOf(line: string): string | undefined {
  const tokens = line.trim().split(/\s+/);
  for (let i = 0; i + 1 < tokens.length; i++) {
    const [type, blob] = [tokens[i] ?? '', tokens[i + 1] ?? ''];
    if (/^(?:ssh-|ecdsa-|sk-)[a-z0-9@.-]+$/.test(type) && /^AAAA[A-Za-z0-9+/]+=*$/.test(blob))
      return `${type} ${blob}`;
  }
  return undefined;
}

function keysIn(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
    .map((line) => {
      const key = keyOf(line);
      if (key === undefined) throw new KeyError(`${path}: not a public key line: ${line}`);
      return key;
    });
}

/** The last key of `allowed_signers` (oldest first) that is not revoked. */
export function newestKey(keys: ReleaseKeys): string | undefined {
  const revoked = new Set(keysIn(keys.revokedKeys));
  return keysIn(keys.allowedSigners)
    .filter((key) => !revoked.has(key))
    .at(-1);
}

/**
 * Step 3's two-copy check. `previousNewest` is the newest key of the release pinned before
 * main's last signed upgrade merge, when that merge changed it (from the history audit).
 */
export function checkSecondCopy(
  keys: ReleaseKeys,
  secondCopy: string | undefined,
  previousNewest?: string,
): KeyCheck {
  const newest = newestKey(keys);
  const second = secondCopy === undefined ? undefined : keyOf(secondCopy);
  if (newest === undefined)
    return { status: 'tampering', reason: 'the pinned allowed_signers has no usable key' };
  if (second === undefined)
    return { status: 'tampering', reason: 'no second copy of the Owner key is set' };
  if (second === newest) return { status: 'ok' };

  const previous = previousNewest === undefined ? undefined : keyOf(previousNewest);
  const listed = keysIn(keys.allowedSigners).includes(second);
  const revoked = keysIn(keys.revokedKeys).includes(second);
  if (previous !== undefined && second === previous && listed && !revoked) {
    return {
      status: 'rotation-pending',
      reason: `key rotation pending: set ${SECOND_COPY_VAR} and the laptop key to the newest key in allowed_signers`,
    };
  }
  return {
    status: 'tampering',
    reason: 'the second copy of the Owner key differs from the newest key in allowed_signers',
  };
}

/** Cloud: the routine variable. Laptop: the public half of the key it signs with. */
export function secondCopy(env: NodeJS.ProcessEnv, home: string): string | undefined {
  if (env[CLOUD_MARKER] !== undefined) return env[SECOND_COPY_VAR];
  try {
    return readFileSync(`${ownerKeyPath(home)}.pub`, 'utf8');
  } catch {
    return undefined;
  }
}

function gitShow(repo: string, object: string): string | undefined {
  const result = spawnSync('git', ['-C', repo, 'show', object], { encoding: 'utf8' });
  if (result.error) throw new KeyError(`could not run git: ${result.error.message}`);
  return result.status === 0 ? result.stdout : undefined;
}

/**
 * Write the key lists of the release at `sha` in a factory repository clone into `dir`. Both
 * files must exist in the release; a missing revocation list is refused, not taken as empty.
 */
export function releaseKeys(factoryRepo: string, sha: string, dir: string): ReleaseKeys {
  const out = {
    allowedSigners: join(dir, 'allowed_signers'),
    revokedKeys: join(dir, 'revoked_keys'),
  };
  for (const [name, path] of [
    ['allowed_signers', out.allowedSigners],
    ['revoked_keys', out.revokedKeys],
  ] as const) {
    const text = gitShow(factoryRepo, `${sha}:${name}`);
    if (text === undefined) throw new KeyError(`factory release ${sha} has no ${name}`);
    writeFileSync(path, text);
  }
  return out;
}

/** The factory release pinned in `.factory/config` on main (`mainRef`), never the work tree. */
export function pinOnMain(projectRepo: string, mainRef = 'origin/main'): ReleasePin {
  const text = gitShow(projectRepo, `${mainRef}:.factory/config`);
  if (text === undefined) throw new KeyError(`${mainRef} has no .factory/config`);
  return parseConfig(text).factory_release;
}

/**
 * The laptop's own key list (`~/.factory/allowed_signers`, written by `factory keygen`) and
 * revocation list; an absent revocation list is created empty. Used only where no project pin
 * exists yet (`factory new` verifying the release tag).
 */
export function laptopKeys(home: string): ReleaseKeys {
  const dir = join(home, '.factory');
  const keys = {
    allowedSigners: join(dir, 'allowed_signers'),
    revokedKeys: join(dir, 'revoked_keys'),
  };
  if (!existsSync(keys.allowedSigners))
    throw new RefusedError(`${keys.allowedSigners} not found; run factory keygen first`);
  if (!existsSync(keys.revokedKeys)) writeFileSync(keys.revokedKeys, '');
  return keys;
}

/** The factory clone this CLI was built from; `FACTORY_SOURCE` names another one. */
export function factorySource(env: NodeJS.ProcessEnv): string {
  return env.FACTORY_SOURCE ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * The key lists of the factory release pinned on main, written into `dir`: the inputs every
 * main-side check uses. Main is fetched first and a failed fetch refuses, so a stale pin never
 * decides; a release whose lists cannot be read refuses too.
 */
export function mainKeys(projectRepo: string, env: NodeJS.ProcessEnv, dir: string): ReleaseKeys {
  const fetched = spawnSync('git', ['-C', projectRepo, 'fetch', '-q', 'origin', 'main'], {
    env,
    encoding: 'utf8',
  });
  if (fetched.error !== undefined || fetched.status !== 0)
    throw new KeyError(`cannot fetch main: ${fetched.stderr.trim() || 'git fetch failed'}`);
  return releaseKeys(factorySource(env), pinOnMain(projectRepo).sha, dir);
}
