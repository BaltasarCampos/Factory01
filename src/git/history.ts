// Signed main history (data-model.md § Signed main history, FR-016g, research R18). Every
// first-parent commit after `baseline` (or from the root) must pass `git verify-commit` against
// an Owner key list pinned on main.
//
// Which list: the release pinned in `.factory/config` at the commit's first parent, which the
// walk has already verified, so no commit can repoint the pin to keys that accept it. The first
// commit after `baseline` (the adopt commit) or the root (the `new` commit) carries the pin it is
// verified with; that is where the chain of trust starts. On the laptop that commit must also
// verify against the laptop's own key lists, so a key revoked since cannot sign an adopt commit
// pinned to an old release that still lists it. An upgrade merge is verified with the pin before
// it, and commits after it with the new release's keys.
//
// `baseline` comes from the tip's config, so it must be where adoption happened: the parent of
// the oldest first-parent commit holding `.factory/config`.
//
// A shallow clone is deepened until the walk reaches `baseline` or the root. On the laptop the
// ledger `~/.factory/verified/<repo>` holds the last commit verified and the baseline: commits up
// to it are not checked again. A clone whose main is behind it fetches and walks once more; a
// main that neither contains it nor is behind it was rewritten, and one that names another
// baseline fails too. Only `origin/main` may be walked with the ledger.
//
// Everything fails closed: when git or ssh-keygen cannot run, a key list or a pin cannot be
// read, or the history cannot be deepened, the walk throws instead of reporting a result.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReleaseKeys } from '../approvals/keys.js';
import { RefusedError } from '../cli/env.js';
import { parseConfig } from '../model/config.js';
import type { ReleasePin } from '../model/types.js';

export class HistoryError extends RefusedError {}

/** The key lists of a factory release, by its pin. */
export type KeysFor = (pin: ReleasePin) => ReleaseKeys;

export interface HistoryOptions {
  /** Default `origin/main`. */
  ref?: string;
  /** The last unsigned commit (`.factory/config`); the walk starts after it. */
  baseline?: string | undefined;
  /** The laptop ledger file (`ledgerPath`); absent in the cloud. */
  ledger?: string;
  /** The laptop's own key lists (`laptopKeys`), which must also accept the first commit. */
  anchorKeys?: ReleaseKeys;
  env?: NodeJS.ProcessEnv;
}

export interface MainWalk {
  /** The last first-parent commit verified as Owner-signed, with all before it since baseline. */
  lastVerified: string | undefined;
  /** The first commit that failed, when one did; nothing after it is read. */
  rejected?: { commit: string; reason: string };
  /** Verified first-parent commits after baseline, oldest first. */
  commits: { commit: string; parents: string[]; trailers: string }[];
}

export type HistoryVerdict =
  { ok: true; head: string } | { ok: false; commit: string; reason: string };

const CONFIG = '.factory/config';

/** `~/.factory/verified/<owner>/<name>`: the last commit of main this laptop verified. */
export const ledgerPath = (home: string, repo: string): string =>
  join(home, '.factory', 'verified', ...repo.split('/'));

type Run = (
  program: string,
  args: readonly string[],
) => { status: number; stdout: string; stderr: string };

function runner(repo: string, env: NodeJS.ProcessEnv | undefined): Run {
  return (program, args) => {
    const result = spawnSync(program, args, { cwd: repo, env, encoding: 'utf8' });
    if (result.error !== undefined || result.status === null)
      throw new HistoryError(`cannot run ${program}: ${result.error?.message ?? 'killed'}`);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
}

/** Deepen a shallow clone until `ref`'s first-parent history reaches `baseline` or the root. */
function deepen(run: Run, ref: string, baseline: string | undefined): void {
  const slash = ref.indexOf('/');
  const [remote, branch] =
    slash < 0 ? ['origin', ref] : [ref.slice(0, slash), ref.slice(slash + 1)];
  const gitDir = run('git', ['rev-parse', '--absolute-git-dir']).stdout.trim();
  const shallow = (): Set<string> => {
    try {
      return new Set(readFileSync(join(gitDir, 'shallow'), 'utf8').split('\n').filter(Boolean));
    } catch {
      return new Set();
    }
  };
  const reached = (): boolean => {
    const listed = run('git', ['rev-list', '--first-parent', ref]);
    if (listed.status !== 0)
      throw new HistoryError(`cannot read the history of ${ref}: ${listed.stderr.trim()}`);
    const commits = listed.stdout.split('\n').filter(Boolean);
    const last = commits.at(-1);
    const boundary = last !== undefined && shallow().has(last);
    if (baseline === undefined ? last !== undefined && !boundary : commits.includes(baseline))
      return true;
    if (boundary) return false;
    throw new HistoryError(
      baseline === undefined
        ? `${ref} has no commits`
        : `baseline ${baseline} is not on the first-parent history of ${ref}`,
    );
  };
  for (let depth = 64; !reached(); depth *= 2) {
    if (shallow().size === 0 || depth > 1 << 20)
      throw new HistoryError(`cannot deepen ${ref} to ${baseline ?? 'the root'}`);
    const how = baseline === undefined ? '--unshallow' : `--deepen=${String(depth)}`;
    const fetched = run('git', ['fetch', '-q', how, remote, branch]);
    if (fetched.status !== 0)
      throw new HistoryError(
        `cannot deepen ${ref}: ${fetched.stderr.trim() || 'git fetch failed'}`,
      );
  }
  // `baseline` is read from the tip's config. It is the last commit before adoption, so it has
  // no config of its own; otherwise any commit could name its parent and pin its own keys.
  if (baseline === undefined) return;
  if (run('git', ['cat-file', '-e', `${baseline}:.factory/config`]).status === 0)
    throw new HistoryError(
      `baseline ${baseline} has .factory/config: it is not the commit before adoption`,
    );
  // The adopt commit added the config; its first parent is the only valid baseline.
  const changes = run('git', ['rev-list', '--first-parent', '--reverse', ref, '--', CONFIG]);
  const adopt = changes.stdout.split('\n')[0] ?? '';
  const parent = run('git', ['rev-parse', '-q', '--verify', `${adopt}^1`]).stdout.trim();
  if (adopt === '' || parent !== baseline)
    throw new HistoryError(
      `baseline ${baseline} is not where adoption happened: the parent of ${adopt || 'no commit'}, the first commit of ${ref} with ${CONFIG}`,
    );
}

interface Ledger {
  commit: string;
  baseline: string | undefined;
}

function readLedger(path: string): Ledger | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const commit = /^commit ([0-9a-f]{40})$/m.exec(text)?.[1];
  const baseline = /^baseline ([0-9a-f]{40}|none)$/m.exec(text)?.[1];
  if (commit === undefined || baseline === undefined)
    throw new HistoryError(`cannot read the signed-history ledger ${path}`);
  return { commit, baseline: baseline === 'none' ? undefined : baseline };
}

/** Walk main's first-parent history after `baseline`, oldest first, verifying each commit. */
export function walkMain(repo: string, keysFor: KeysFor, options: HistoryOptions = {}): MainWalk {
  return walk(repo, keysFor, options, false);
}

function walk(repo: string, keysFor: KeysFor, options: HistoryOptions, fetched: boolean): MainWalk {
  const run = runner(repo, options.env);
  const ref = options.ref ?? 'origin/main';
  const baseline = options.baseline;
  // The ledger is main's: no other ref may record a commit in it.
  if (options.ledger !== undefined && ref !== 'origin/main')
    throw new HistoryError(`the ledger records origin/main only, not ${ref}`);
  const out: MainWalk = { lastVerified: undefined, commits: [] };
  const recorded = options.ledger === undefined ? undefined : readLedger(options.ledger);
  if (recorded !== undefined && recorded.baseline !== baseline) {
    const reason = `main's config names baseline ${baseline ?? 'none'}, not ${recorded.baseline ?? 'none'}, the baseline this laptop recorded`;
    return { ...out, rejected: { commit: recorded.commit, reason } };
  }
  deepen(run, ref, baseline);

  const range = baseline === undefined ? ref : `${baseline}..${ref}`;
  const format = '--format=%H %P%x1f%(trailers:key=Factory-Merge,valueonly)%x1e';
  const args = ['log', '--first-parent', '--reverse', format, range];
  const log = run('git', ['-c', 'log.showSignature=false', ...args]);
  if (log.status !== 0)
    throw new HistoryError(`cannot read the history of ${range}: ${log.stderr.trim()}`);
  const entries = log.stdout.split('\x1e').flatMap((entry) => {
    const [head = '', trailers = ''] = entry.trim().split('\x1f');
    const [commit, ...parents] = head.split(' ').filter((s) => s !== '');
    return commit === undefined ? [] : [{ commit, parents, trailers }];
  });
  // git verify-commit runs ssh-keygen; if it cannot start, every commit would read as unsigned.
  run('ssh-keygen', ['-?']);

  const trustedUpTo =
    recorded === undefined ? -1 : entries.findIndex((e) => e.commit === recorded.commit);
  if (recorded !== undefined && trustedUpTo < 0) {
    // 0: this clone's main is an ancestor of the recorded commit, so it is behind (another clone
    // recorded a newer main); 1: it is not; otherwise this clone lacks the recorded commit.
    const behind = run('git', ['merge-base', '--is-ancestor', ref, recorded.commit]).status;
    if (behind !== 1 && !fetched) {
      const fetch = run('git', ['fetch', '-q', 'origin', 'main']);
      if (fetch.status !== 0)
        throw new HistoryError(`cannot fetch main: ${fetch.stderr.trim() || 'git fetch failed'}`);
      return walk(repo, keysFor, options, true);
    }
    if (behind === 0) throw new HistoryError('this clone is behind the ledger; fetch first');
    const reason = `main no longer contains ${recorded.commit}, the last commit this laptop verified: its history was rewritten`;
    return { ...out, rejected: { commit: recorded.commit, reason } };
  }

  const signedUnder = (keys: ReleaseKeys, commit: string): boolean => {
    const verify = [
      ...['-c', `gpg.ssh.allowedSignersFile=${keys.allowedSigners}`],
      ...['-c', `gpg.ssh.revocationFile=${keys.revokedKeys}`],
      ...['-c', 'gpg.ssh.program=ssh-keygen'],
      // A good signature by a key no allowed_signers line names has trust "undefined"; require
      // a listed key even where git would accept it.
      ...['-c', 'gpg.minTrustLevel=fully'],
    ];
    return run('git', [...verify, 'verify-commit', commit]).status === 0;
  };
  const keysByPin = new Map<string, ReleaseKeys>();
  const keysAt = (commit: string): ReleaseKeys => {
    const shown = run('git', ['show', `${commit}:.factory/config`]);
    let pin: ReleasePin;
    try {
      if (shown.status !== 0) throw new Error(shown.stderr.trim());
      pin = parseConfig(shown.stdout).factory_release;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new HistoryError(`cannot read the factory release pinned at ${commit}: ${why}`);
    }
    let keys = keysByPin.get(pin.sha);
    if (keys === undefined) {
      keys = keysFor(pin);
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
      keysByPin.set(pin.sha, keys);
    }
    return keys;
  };

  for (const [i, entry] of entries.entries()) {
    if (i > trustedUpTo) {
      const keys = keysAt(i === 0 ? entry.commit : (entries[i - 1]?.commit ?? entry.commit));
      if (!signedUnder(keys, entry.commit)) {
        const reason = `${entry.commit} is not signed by a listed, non-revoked Owner key`;
        out.rejected = { commit: entry.commit, reason };
        break;
      }
      if (
        i === 0 &&
        options.anchorKeys !== undefined &&
        !signedUnder(options.anchorKeys, entry.commit)
      ) {
        const reason = `${entry.commit}, the first commit after the baseline, is not signed by a key in the laptop's own key lists that they do not revoke`;
        out.rejected = { commit: entry.commit, reason };
        break;
      }
    }
    out.lastVerified = entry.commit;
    out.commits.push(entry);
  }
  if (options.ledger !== undefined && out.lastVerified !== undefined) {
    mkdirSync(dirname(options.ledger), { recursive: true });
    writeFileSync(options.ledger, `commit ${out.lastVerified}\nbaseline ${baseline ?? 'none'}\n`);
  }
  return out;
}

/**
 * FR-016g: whether every first-parent commit of `ref` after `baseline` (or from the root) is
 * Owner-signed; when not, the first commit that is not.
 */
export function verifyFirstParent(
  repo: string,
  baseline: string | undefined,
  keysFor: KeysFor,
  options: Omit<HistoryOptions, 'baseline'> = {},
): HistoryVerdict {
  const walk = walkMain(repo, keysFor, { ...options, baseline });
  if (walk.rejected !== undefined) return { ok: false, ...walk.rejected };
  const head = walk.lastVerified ?? baseline;
  if (head === undefined) throw new HistoryError(`${options.ref ?? 'origin/main'} has no commits`);
  return { ok: true, head };
}
