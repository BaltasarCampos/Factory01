// `Factory-Merge:` trailers on main (design v1.8 § Merging and verification, AC-006). `factory
// merge` writes one into every signed merge commit (`#<issue>`, `define`, `upgrade <tag>`,
// `factory-log`); the brief rule and the once-only rule read only these.
//
// A trailer counts only on a first-parent commit after `baseline` that `git verify-commit`
// accepts against main's pinned `allowed_signers` and `revoked_keys`. Authorship never counts.
// The walk goes oldest first and stops at the first commit it rejects, since nothing after an
// unsigned commit can be trusted. It fails closed: when either list cannot be read, or git or
// ssh-keygen cannot run, it throws instead of reporting no merges.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { ReleaseKeys } from '../approvals/keys.js';
import { RefusedError } from '../cli/env.js';

export class HistoryError extends RefusedError {}

export interface MainMerges {
  /** The last first-parent commit verified as Owner-signed, with all before it since baseline. */
  lastVerified: string | undefined;
  /** `Factory-Merge:` values on verified merge commits, oldest first. */
  merges: { commit: string; value: string }[];
}

export interface MergesOptions {
  /** Default `origin/main`. */
  ref?: string;
  /** The last unsigned commit (`.factory/config`); the walk starts after it. */
  baseline?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

export function verifiedMerges(
  repo: string,
  keys: ReleaseKeys,
  options: MergesOptions = {},
): MainMerges {
  for (const [name, path] of [
    ['allowed_signers', keys.allowedSigners],
    ['revoked_keys', keys.revokedKeys],
  ] as const) {
    try {
      readFileSync(path);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new HistoryError(`cannot read main's pinned ${name}: ${why}`);
    }
  }
  const run = (program: string, args: readonly string[]) => {
    const result = spawnSync(program, args, { cwd: repo, env: options.env, encoding: 'utf8' });
    if (result.error !== undefined || result.status === null)
      throw new HistoryError(`cannot run ${program}: ${result.error?.message ?? 'killed'}`);
    return result;
  };

  const ref = options.ref ?? 'origin/main';
  const range = options.baseline === undefined ? ref : `${options.baseline}..${ref}`;
  const format = '--format=%H %P%x1f%(trailers:key=Factory-Merge,valueonly)%x1e';
  const args = ['log', '--first-parent', '--reverse', format, range];
  const log = run('git', ['-c', 'log.showSignature=false', ...args]);
  if (log.status !== 0)
    throw new HistoryError(`cannot read the history of ${range}: ${log.stderr.trim()}`);
  // git verify-commit runs ssh-keygen; if it cannot start, every commit would read as unsigned.
  run('ssh-keygen', ['-?']);

  const verify = [
    ...['-c', `gpg.ssh.allowedSignersFile=${keys.allowedSigners}`],
    ...['-c', `gpg.ssh.revocationFile=${keys.revokedKeys}`],
    ...['-c', 'gpg.ssh.program=ssh-keygen'],
    // A good signature by a key no allowed_signers line names has trust "undefined"; require
    // a listed key even where git would accept it.
    ...['-c', 'gpg.minTrustLevel=fully'],
  ];
  const out: MainMerges = { lastVerified: undefined, merges: [] };
  for (const entry of log.stdout.split('\x1e')) {
    const [head = '', trailers = ''] = entry.trim().split('\x1f');
    const [commit, ...parents] = head.split(' ').filter((s) => s !== '');
    if (commit === undefined) continue;
    if (run('git', [...verify, 'verify-commit', commit]).status !== 0) break;
    out.lastVerified = commit;
    if (parents.length < 2) continue;
    for (const value of trailers.split('\n').map((v) => v.trim()))
      if (value !== '') out.merges.push({ commit, value });
  }
  return out;
}

/** The brief rule: main has an Owner-signed `Factory-Merge: define`. */
export const briefMerged = (history: MainMerges): boolean =>
  history.merges.some((m) => m.value === 'define');
