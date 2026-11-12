// The session's commits, read out of its clone (T086, slice 28-5a). No factory git runs in the
// clone, whose `.git/` the session can change: git reads it only inside the factory's bubblewrap
// sandbox, with no network and nothing of home but the clone, read-only, and writes the session's
// new objects as a pack into a folder of the session's own under `~/.factory/`, which no session
// reaches. The factory's own clone, the record's `project`, indexes that pack with
// `index-pack --strict`, which checks each object as `transfer.fsckObjects` does on a fetch (git
// 2.39.5's fetch from a bundle checks none: Owner decision 2026-11-12), then checks that the
// history from the new commit back to the record's head is whole, and keeps the commit under
// `refs/factory/sessions/<id>`, where the station checks read it. The head the session's clone
// claims is never trusted: the commit must be one the factory indexed.
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { probeBwrap, sandboxArgs } from '../ci/sandbox.js';
import { EnvironmentError } from '../cli/env.js';
import { safeGit } from '../git/diff.js';
import { visible } from '../notify/summary.js';
import { sessionFolder, type SessionRecord } from './session.js';

/** What a station check reads: the session's head, in the factory's own clone. */
export interface SessionOutput {
  /** The factory's own clone of the project, the dispatcher's. */
  repo: string;
  /** The session's head, under `refs/factory/sessions/<id>` there. */
  commit: string;
  /** The commit the session's clone was made from, the record's. */
  head: string;
  /** `specs/<issue>-<slug>`, or empty for a role on a fixed branch. */
  feature: string;
  branch: string;
}

/** Each git run in the sandbox; the Stop hook's own timeout is 28-5c's. */
const READ_TIMEOUT = 120_000;
/** The largest pack of new objects a session may add. */
export const MAX_PACK = 256 * 1024 * 1024;
const OID = /^[0-9a-f]{40}$/;

/** The ref a session's head is kept under, in the factory's own clone. */
export const sessionRef = (session: string) => `refs/factory/sessions/${session}`;

/** Why the session's head cannot be taken, for the session to fix: its clone is its own. */
export class UnreadableHead extends Error {}

/**
 * What the sandbox read from the clone: the head the clone claims and, when it differs from the
 * record's head, the pack of the objects since, written to `pack`.
 */
export type ReadClone = (
  clone: string,
  head: string,
  pack: string,
  work: string,
  env: NodeJS.ProcessEnv,
) => string;

/** Git in the clone, inside the factory's sandbox: the clone read-only, `work` the one folder writable. */
function inSandbox(
  args: readonly string[],
  clone: string,
  work: string,
  env: NodeJS.ProcessEnv,
  io: { input?: string; stdout?: number } = {},
) {
  const box = sandboxArgs(work, clone, [clone]);
  const outer = probeBwrap(
    box,
    env,
    "the session's clone is read only inside bubblewrap, which failed (install it with: sudo apt install bubblewrap)",
  );
  const result = spawnSync('bwrap', [...box, 'git', '-c', 'core.hooksPath=/dev/null', ...args], {
    env: outer,
    encoding: 'utf8',
    timeout: READ_TIMEOUT,
    ...(io.input === undefined ? {} : { input: io.input }),
    stdio: ['pipe', io.stdout ?? 'pipe', 'pipe'],
  });
  if (result.error !== undefined || result.status !== 0)
    throw new UnreadableHead(
      `git ${args[0] ?? ''} in its clone failed: ${visible(result.error?.message ?? result.stderr.trim())}`,
    );
  // Null when its output went to a file.
  return (result.stdout as string | null) ?? '';
}

/** The clone's HEAD and, past the record's head, the pack of what it adds: git in the sandbox. */
export const sandboxRead: ReadClone = (clone, head, pack, work, env) => {
  const tip = inSandbox(
    ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
    clone,
    work,
    env,
  ).trim();
  if (!OID.test(tip)) throw new UnreadableHead(`its HEAD reads as ${visible(tip)}, not a commit`);
  if (tip === head) return tip;
  const out = openSync(pack, 'wx', 0o600);
  try {
    inSandbox(['pack-objects', '--revs', '--thin', '--stdout', '-q'], clone, work, env, {
      input: `${tip}\n^${head}\n`,
      stdout: out,
    });
  } finally {
    closeSync(out);
  }
  return tip;
};

/** The objects of the pack index-pack wrote, by the pack's name in its output. */
function packObjects(repo: string, out: string, env: NodeJS.ProcessEnv): Set<string> {
  const name = /^pack\t([0-9a-f]{40})$/.exec(out.trim())?.[1];
  if (name === undefined)
    throw new EnvironmentError(`git index-pack in ${repo} named no pack: ${visible(out)}`);
  const at = safeGit(repo, ['rev-parse', '--git-path', `objects/pack/pack-${name}.idx`], env);
  if (at.status !== 0) throw new EnvironmentError(`git rev-parse in ${repo} failed: ${at.stderr}`);
  const idx = openSync(resolve(repo, at.stdout.toString().trim()), 'r');
  try {
    const listed = safeGit(repo, ['show-index'], env, idx);
    if (listed.status !== 0)
      throw new EnvironmentError(`git show-index in ${repo} failed: ${listed.stderr}`);
    return new Set(
      listed.stdout
        .toString()
        .split('\n')
        .map((line) => line.split(' ')[1] ?? ''),
    );
  } finally {
    closeSync(idx);
  }
}

/**
 * The session's head, taken into the factory's own clone and kept under its session ref: a commit
 * the factory indexed itself (or the record's head, when the session added nothing), whose history
 * back to the record's head is whole and has that head in it; else an `UnreadableHead`.
 */
export function sessionOutput(
  record: SessionRecord,
  home: string,
  session: string,
  env: NodeJS.ProcessEnv = process.env,
  read: ReadClone = sandboxRead,
): SessionOutput {
  const { project: repo, clone, head } = record;
  const work = mkdtempSync(join(sessionFolder(home, session), 'read-'));
  try {
    const pack = join(work, 'session.pack');
    const claimed = read(clone, head, pack, work, env);
    if (claimed !== head) {
      const size = statSync(pack).size;
      if (size > MAX_PACK)
        throw new UnreadableHead(
          `its commits since ${head.slice(0, 12)} hold ${String(size)} bytes, past the ${String(MAX_PACK)} a session may add`,
        );
      const into = openSync(pack, 'r');
      let indexed: ReturnType<typeof safeGit>;
      try {
        indexed = safeGit(repo, ['index-pack', '--strict', '--fix-thin', '--stdin'], env, into);
      } finally {
        closeSync(into);
      }
      if (indexed.status !== 0)
        throw new UnreadableHead(
          `its commits do not pass git's object checks: ${visible(indexed.stderr)}`,
        );
      if (!packObjects(repo, indexed.stdout.toString(), env).has(claimed))
        throw new UnreadableHead(
          `its head ${visible(claimed.slice(0, 12))} is not a commit its own commits hold`,
        );
      const whole = safeGit(
        repo,
        ['rev-list', '--objects', '--missing=error', claimed, `^${head}`],
        env,
      );
      if (whole.status !== 0)
        throw new UnreadableHead(
          `its history back to ${head.slice(0, 12)} is not whole: ${visible(whole.stderr)}`,
        );
    }
    // Exit 1 alone means not an ancestor; any other failure is the factory's clone's.
    const ancestor = safeGit(repo, ['merge-base', '--is-ancestor', head, claimed], env);
    if (ancestor.status === 1)
      throw new UnreadableHead(
        `its head ${claimed.slice(0, 12)} does not follow ${head.slice(0, 12)}, the commit it was issued: add commits, never rewrite`,
      );
    if (ancestor.status !== 0)
      throw new EnvironmentError(`git merge-base in ${repo} failed: ${ancestor.stderr}`);
    const ref = safeGit(repo, ['update-ref', sessionRef(session), claimed], env);
    if (ref.status !== 0)
      throw new EnvironmentError(`git update-ref in ${repo} failed: ${ref.stderr}`);
    return { repo, commit: claimed, head, feature: record.feature, branch: record.branch };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
