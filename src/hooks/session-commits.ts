// The session's commits, read out of its clone (T086, slice 28-5a). No factory git runs in the
// clone, whose `.git/` the session can change: git reads it only inside the factory's bubblewrap
// sandbox, with no network, `protocol.allow=never`, nothing of home but the clone, read-only, and
// nothing writable at all, and sends the session's new objects as a full pack on its stdout, which
// the factory counts and stops past `MAX_PACK`. The factory indexes that pack with
// `index-pack --strict`, which checks each object as `transfer.fsckObjects` does on a fetch (git
// 2.39.5's fetch from a bundle checks none: Owner decision 2026-11-12), into a quarantine under the
// session's own folder, the factory's clone's objects its alternate; there the head must be a
// commit of that pack, its history back to the record's head whole and that head its ancestor.
// Only then does the pack move into the factory's clone, the record's `project`, and the commit
// go under `refs/factory/sessions/<id>`, where the station checks read it. A refused pack leaves
// nothing there, and the head the session's clone claims is never trusted on its own.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { renameSync, rmSync } from 'node:fs';
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

/**
 * Each git run, in the sandbox or the factory's own, killed with SIGKILL past it; the Stop hook's
 * own overall timeout is 28-5c's.
 */
const GIT_TIMEOUT = 120_000;
/** The largest pack of new objects a session may add; the factory holds it in memory. */
export const MAX_PACK = 64 * 1024 * 1024;
const OID = /^[0-9a-f]{40}$/;

/** The ref a session's head is kept under, in the factory's own clone. */
export const sessionRef = (session: string) => `refs/factory/sessions/${session}`;
/**
 * The ref of the head whose output check passed, for a session whose start passed: written by the
 * Stop hook only then, and only what the launcher pushes (28-6), which checks it again.
 */
export const passedRef = (session: string) => `refs/factory/passed/${session}`;

/** Why the session's head cannot be taken, for the session to fix: its clone is its own. */
export class UnreadableHead extends Error {}

/** What the sandbox read from the clone: the head it claims, and past the record's, its pack. */
export interface CloneRead {
  tip: string;
  pack?: Buffer;
}
export type ReadClone = (
  clone: string,
  head: string,
  box: string,
  env: NodeJS.ProcessEnv,
  limit: number,
) => CloneRead;

/**
 * Bubblewrap's arguments for git in the clone: the clone read-only, and nothing writable, the
 * sandbox's own folder, /tmp and /dev/shm remounted read-only after they are made.
 */
export const readOnlyBox = (box: string, clone: string) => [
  ...sandboxArgs(box, clone, [clone]),
  ...['--remount-ro', box, '--remount-ro', '/tmp', '--remount-ro', '/dev/shm'],
];

/** `command` in the read-only sandbox over the clone, its stdout capped at `io.limit` bytes. */
export function inBox(
  command: readonly string[],
  clone: string,
  box: string,
  env: NodeJS.ProcessEnv,
  io: { input?: string; limit?: number; name?: string; over?: string } = {},
): Buffer {
  const argv = readOnlyBox(box, clone);
  const limit = io.limit ?? 1024 * 1024;
  const outer = probeBwrap(
    argv,
    env,
    "the session's clone is read only inside bubblewrap, which failed (install it with: sudo apt install bubblewrap)",
  );
  const result = spawnSync('bwrap', [...argv, ...command], {
    env: outer,
    timeout: GIT_TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: limit,
    ...(io.input === undefined ? {} : { input: io.input }),
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOBUFS')
    throw new UnreadableHead(
      io.over ??
        `its commits since the head it was issued hold more than the ${String(limit)} bytes a session may add`,
    );
  if (result.error !== undefined || result.status !== 0)
    throw new UnreadableHead(
      `${io.name ?? command[0] ?? ''} in its clone failed: ${visible(result.error?.message ?? result.stderr.toString().trim())}`,
    );
  return result.stdout;
}

/** Git in the read-only sandbox over the clone: no hooks, no transport. */
export const inSandbox = (
  args: readonly string[],
  clone: string,
  box: string,
  env: NodeJS.ProcessEnv,
  io: { input?: string; limit?: number; name?: string; over?: string } = {},
): Buffer => {
  const git = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', ...args];
  return inBox(git, clone, box, env, { name: `git ${args[0] ?? ''}`, ...io });
};

/** The clone's HEAD and, past the record's head, a full pack of what it adds: git in the sandbox. */
export const sandboxRead: ReadClone = (clone, head, box, env, limit) => {
  const tip = inSandbox(
    ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
    clone,
    box,
    env,
  )
    .toString()
    .trim();
  if (!OID.test(tip)) throw new UnreadableHead(`its HEAD reads as ${visible(tip)}, not a commit`);
  if (tip === head) return { tip };
  const pack = inSandbox(['pack-objects', '--revs', '--stdout', '-q'], clone, box, env, {
    input: `${tip}\n^${head}\n`,
    limit,
  });
  return { tip, pack };
};

/** Git of the factory's own, bounded: a run that fails to finish is the factory's error. */
export function own(
  repo: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  more: Parameters<typeof safeGit>[5] = {},
  input?: Buffer,
) {
  let result: ReturnType<typeof safeGit>;
  try {
    result = safeGit(repo, args, env, input, undefined, { timeout: GIT_TIMEOUT, ...more });
  } catch (err) {
    throw new EnvironmentError(`git ${args[0] ?? ''} in ${repo} did not finish: ${String(err)}`);
  }
  return { status: result.status, out: result.stdout.toString().trim(), err: result.stderr };
}

/** As `own`, but anything other than success is the factory's error. */
export function ownOk(
  repo: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  more?: Parameters<typeof safeGit>[5],
) {
  const result = own(repo, args, env, more);
  if (result.status !== 0)
    throw new EnvironmentError(`git ${args[0] ?? ''} in ${repo} failed: ${result.err}`);
  return result.out;
}

/** Moves a file into `folder`, by rename, or by copy and rename across filesystems. */
function moveInto(file: string, folder: string) {
  const to = join(folder, file.split('/').at(-1) ?? '');
  try {
    renameSync(file, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    copyFileSync(file, `${to}.moving`);
    renameSync(`${to}.moving`, to);
  }
}

/**
 * Indexes the session's pack in a quarantine whose alternate is the factory's clone, checks it
 * there and moves it in only when every check passes; the commit it names, else an
 * `UnreadableHead`.
 */
function quarantined(
  repo: string,
  claimed: string,
  head: string,
  pack: Buffer,
  work: string,
  env: NodeJS.ProcessEnv,
) {
  const objects = resolve(repo, ownOk(repo, ['rev-parse', '--git-path', 'objects'], env));
  const held = join(work, 'objects');
  mkdirSync(join(held, 'pack'), { recursive: true });
  const more = { env: { GIT_OBJECT_DIRECTORY: held, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects } };
  // A full pack: every object checked is one the session sent.
  const indexed = own(repo, ['index-pack', '--strict', '--stdin'], env, more, pack);
  if (indexed.status !== 0)
    throw new UnreadableHead(
      `its commits do not pass git's object checks: ${visible(indexed.err)}`,
    );
  const name = /^pack\t([0-9a-f]{40})$/.exec(indexed.out)?.[1];
  if (name === undefined)
    throw new EnvironmentError(`git index-pack in ${repo} named no pack: ${visible(indexed.out)}`);
  const files = readdirSync(join(held, 'pack')).filter((f) => f.startsWith(`pack-${name}.`));
  // Asked of the quarantine alone, with no alternate, so an object only the factory's clone holds
  // reads as missing; git looks up the one object, holding no list of the pack in memory.
  const alone = { env: { GIT_OBJECT_DIRECTORY: held } };
  const asked = own(repo, ['cat-file', '--batch-check'], env, alone, Buffer.from(`${claimed}\n`));
  if (asked.status !== 0)
    throw new EnvironmentError(`git cat-file in ${repo} failed: ${visible(asked.err)}`);
  const [oid, type = ''] = asked.out.split(' ');
  if (oid !== claimed || type === 'missing')
    throw new UnreadableHead(
      `its head ${visible(claimed.slice(0, 12))} is not an object its own commits hold`,
    );
  if (type !== 'commit')
    throw new UnreadableHead(
      `its head ${claimed.slice(0, 12)} is a ${visible(type)}, not a commit`,
    );
  const whole = own(
    repo,
    ['rev-list', '--objects', '--missing=error', claimed, `^${head}`],
    env,
    more,
  );
  if (whole.status !== 0)
    throw new UnreadableHead(
      `its history back to ${head.slice(0, 12)} is not whole: ${visible(whole.err)}`,
    );
  follows(repo, head, claimed, env, more);
  // Every check passed: the pack, then its index, which makes git see it.
  for (const f of files.sort((a, b) => Number(a.endsWith('.idx')) - Number(b.endsWith('.idx'))))
    moveInto(join(held, 'pack', f), join(objects, 'pack'));
}

/** The record's head must be an ancestor of the head: exit 1 alone means it is not. */
function follows(
  repo: string,
  head: string,
  claimed: string,
  env: NodeJS.ProcessEnv,
  more?: Parameters<typeof safeGit>[5],
) {
  const ancestor = own(repo, ['merge-base', '--is-ancestor', head, claimed], env, more);
  if (ancestor.status === 1)
    throw new UnreadableHead(
      `its head ${claimed.slice(0, 12)} does not follow ${head.slice(0, 12)}, the commit it was issued: add commits, never rewrite`,
    );
  if (ancestor.status !== 0)
    throw new EnvironmentError(`git merge-base in ${repo} failed: ${ancestor.err}`);
}

/**
 * The session's head, taken into the factory's own clone and kept under its session ref: the
 * record's head when the session added nothing, else a commit of the pack the factory indexed and
 * checked in quarantine; else an `UnreadableHead`.
 */
export function sessionOutput(
  record: SessionRecord,
  home: string,
  session: string,
  env: NodeJS.ProcessEnv = process.env,
  read: ReadClone = sandboxRead,
  limit = MAX_PACK,
): SessionOutput {
  const { project: repo, clone, head } = record;
  const work = mkdtempSync(join(sessionFolder(home, session), 'read-'));
  try {
    const box = join(work, 'box');
    mkdirSync(box);
    const { tip, pack } = read(clone, head, box, env, limit);
    if (tip !== head) {
      if (pack === undefined)
        throw new EnvironmentError(`no pack was read for ${tip.slice(0, 12)}`);
      if (pack.length > limit)
        throw new UnreadableHead(
          `its commits since the head it was issued hold more than the ${String(limit)} bytes a session may add`,
        );
      quarantined(repo, tip, head, pack, work, env);
    }
    ownOk(repo, ['update-ref', sessionRef(session), tip], env);
    return { repo, commit: tip, head, feature: record.feature, branch: record.branch };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
