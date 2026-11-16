// The Stop hook's commit for the roles that commit nothing themselves, Spec, Planner, the
// Reviewer and Security (T086, slice 28-5b). Their output files are read from the session's clone
// only inside the factory's read-only sandbox, each a regular file with no link on its path, and
// committed in the factory's own clone with plumbing: a temporary index on the head the session
// was issued, a fixed factory author per role, the `Factory-Role` and `Factory-Item` trailers and
// none of the Owner's git config. Only the role's own paths, from the installed `roles.yaml`, are
// ever read; a change anywhere else is never committed and is named in the session's log.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EnvironmentError } from '../cli/env.js';
import { deniedWrites, loadPolicy, matchesPath } from '../guard/policy.js';
import { isProtected } from '../install/manifest.js';
import { isPlainPath } from '../model/naming.js';
import { isTestFile, TEST_CONFIG } from '../stations/edges.js';
import type { RoleName } from '../model/types.js';
import { visible } from '../notify/summary.js';
import {
  inBox,
  inSandbox,
  own,
  ownOk,
  sessionRef,
  swapRef,
  UnreadableHead,
  type SessionOutput,
} from './session-commits.js';
import { sessionFolder, type SessionRecord } from './session.js';

/** The roles whose output the Stop hook commits. */
export const HOOK_COMMITS: readonly RoleName[] = [
  'spec',
  'planner',
  'test',
  'reviewer',
  'security',
];

/** The most a role's output may hold, in bytes, all its files together. */
export const MAX_OUTPUT = 8 * 1024 * 1024;

const POLICY = new URL('../../factory/policy/roles.yaml', import.meta.url);
const installedPolicy = () => loadPolicy(readFileSync(POLICY, 'utf8'));

/** The most entries Test's walk of the clone reads. */
export const MAX_WALK = 20_000;

/** The most of git status's output the factory reads for the outside-changes alert. */
export const MAX_STATUS = 4 * 1024 * 1024;

/**
 * Why `path` cannot be committed, by the path guard's rules, lower-cased as it matches them: the
 * role's denied writes and the relative `deny_read` patterns; or none.
 */
function refusal(path: string, denied: readonly string[]): string | undefined {
  if (!isPlainPath(path)) return 'not a plain path';
  if (isProtected(path)) return 'a protected path';
  const lower = path.toLowerCase();
  if (denied.some((pattern) => matchesPath(pattern.toLowerCase(), lower)))
    return 'a path no role may write';
  const parts = path.split('/');
  // git's `verify_path` refuses `.git` in any case, with dots after it.
  if (parts.some((part) => /^\.git\.*$/i.test(part))) return 'a path git refuses';
  // Stricter than git: on Windows `.gitattributes.` reads as `.gitattributes`.
  if (parts.some((part) => part.endsWith('.'))) return 'a name ending in a dot';
  return undefined;
}

/** The role's write column, the feature folder filled in: files, and folders a `/**` names. */
export function outputPaths(record: SessionRecord): { files: string[]; folders: string[] } {
  const policy = installedPolicy();
  const files: string[] = [];
  const folders: string[] = [];
  if (record.feature === '')
    throw new EnvironmentError(
      `the session is not on a work-item branch (on ${visible(record.branch)}): its record names no feature folder for the ${record.role}'s output`,
    );
  for (const pattern of policy.roles[record.role].write) {
    const path = pattern.replaceAll('{feature}', record.feature);
    const folder = path.endsWith('/**') ? path.slice(0, -3) : undefined;
    if (!isPlainPath(folder ?? path))
      throw new EnvironmentError(
        `the installed roles.yaml gives ${record.role} the write path ${pattern}, which the Stop hook cannot commit; reinstall the pinned release`,
      );
    (folder === undefined ? files : folders).push(folder ?? path);
  }
  return { files, folders };
}

/**
 * Run with node inside the sandbox: every file named on its stdin, NUL-separated, and every file
 * under every folder named, as base64, each checked from the clone's root down with lstat, so a
 * link anywhere on its path, or anything but a regular file or folder, is refused rather than
 * followed; a missing one is left out, and one that cannot be read is refused, naming the way out.
 * Past `max` bytes in all it stops. A file named with `h:` gives only its blob id in the object
 * format named, its bytes never leaving the box nor counting toward `max`.
 */
const READER = `
const fs = require('node:fs');
const crypto = require('node:crypto');
const [clone, max, format] = process.argv.slice(1);
const named = fs.readFileSync(0, 'utf8').split('\\0').filter((e) => e !== '');
const out = { files: {}, ids: {}, refused: [] };
let total = 0;
const unreadable = (e) => 'cannot be read (' + (e.code || String(e)) + '): ' +
  (e.code === 'ENAMETOOLONG' ? 'shorten it, or remove it' : 'make it readable, or remove it');
const guard = (rel, f) => { try { f(); } catch (e) { out.refused.push([rel, unreadable(e)]); } };
const kind = (rel) => {
  let at = clone, so = '';
  for (const part of rel.split('/')) {
    at += '/' + part;
    so += (so === '' ? '' : '/') + part;
    let st;
    try { st = fs.lstatSync(at); } catch (e) { if (e.code === 'ENOENT') return 'missing'; throw e; }
    if (st.isSymbolicLink()) return 'a link at ' + so;
    if (!st.isFile() && !st.isDirectory()) return 'not a regular file';
  }
  return fs.lstatSync(at).isDirectory() ? 'folder' : 'file';
};
const read = (rel) => {
  const fd = fs.openSync(clone + '/' + rel, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) return out.refused.push([rel, 'not a regular file']);
    const bytes = fs.readFileSync(fd);
    total += bytes.length;
    if (total > Number(max)) { out.over = true; return; }
    out.files[rel] = bytes.toString('base64');
  } finally { fs.closeSync(fd); }
};
const hash = (rel) => {
  const fd = fs.openSync(clone + '/' + rel, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) return out.refused.push([rel, 'not a regular file']);
    const bytes = fs.readFileSync(fd);
    const id = crypto.createHash(format).update('blob ' + bytes.length + '\\0').update(bytes);
    out.ids[rel] = id.digest('hex');
  } finally { fs.closeSync(fd); }
};
const walk = (rel) => {
  let names;
  try { names = fs.readdirSync(clone + '/' + rel).sort(); } catch (e) { return void out.refused.push([rel, unreadable(e)]); }
  for (const name of names) {
    const at = rel + '/' + name;
    guard(at, () => {
      const k = kind(at);
      if (k === 'folder') walk(at); else if (k === 'file') read(at); else if (k !== 'missing') out.refused.push([at, k]);
    });
  }
};
for (const entry of named) {
  const [type, rel] = [entry.slice(0, 2), entry.slice(2)];
  guard(rel, () => {
    const k = kind(rel);
    if (k === 'missing') return;
    if (type === 'f:' && k === 'file') read(rel);
    else if (type === 'h:' && k === 'file') hash(rel);
    else if (type === 'd:' && k === 'folder') walk(rel);
    else out.refused.push([rel, k === 'folder' ? 'a folder' : k === 'file' ? 'not a folder' : k]);
  });
}
process.stdout.write(JSON.stringify(out));
`;

/**
 * Run with node inside the sandbox: every path under the roots named on its stdin (`r:`, `` for
 * the whole clone), NUL-separated, but under the root `.git` and any `node_modules` folder, not
 * following links, at most `max` entries. A folder named with `s:`, a gitlink in the head, is
 * never walked into: when it holds anything it is `held`. A folder or path that cannot be read
 * stops the walk, `failed` naming it and the way out.
 */
const WALKER = `
const fs = require('node:fs');
const [clone, max] = process.argv.slice(1);
const given = fs.readFileSync(0, 'utf8').split('\\0').filter((e) => e !== '');
const links = new Set(given.filter((e) => e.startsWith('s:')).map((e) => e.slice(2)));
const out = { paths: [], held: [] };
let count = 0;
const fail = (at, e) => void (out.failed = [at, String(e.code || e),
  e.code === 'ENAMETOOLONG' ? 'shorten it, or remove it' : 'make it readable, or remove it']);
const stopped = () => out.over === true || out.failed !== undefined;
const folder = (at) => {
  if (!links.has(at)) return walk(at);
  try { if (fs.readdirSync(clone + '/' + at).length > 0) out.held.push(at); } catch (e) { fail(at, e); }
};
const walk = (rel) => {
  let names;
  try { names = fs.readdirSync(rel === '' ? clone : clone + '/' + rel).sort(); } catch (e) { return fail(rel, e); }
  for (const name of names) {
    if (name === 'node_modules' || (rel === '' && name === '.git')) continue;
    if (++count > Number(max)) return void (out.over = true);
    const at = rel === '' ? name : rel + '/' + name;
    let dir;
    try { dir = fs.lstatSync(clone + '/' + at).isDirectory(); } catch (e) { return fail(at, e); }
    if (dir) folder(at); else out.paths.push(at);
    if (stopped()) return;
  }
};
// A root is walked only when it, and every folder above it, is a folder: a link or a file refuses.
const root = (path) => {
  let at = '';
  for (const part of path.split('/')) {
    at = at === '' ? part : at + '/' + part;
    let st;
    try { st = fs.lstatSync(clone + '/' + at); } catch (e) { return e.code === 'ENOENT' ? undefined : fail(at, e); }
    if (!st.isDirectory())
      return void (out.failed = [at, st.isSymbolicLink() ? 'a link' : 'not a folder', 'make it a folder, or remove it']);
  }
  folder(path);
};
for (const r of given.filter((e) => e.startsWith('r:')).map((e) => e.slice(2))) {
  if (r === '') walk(''); else root(r);
  if (stopped()) break;
}
process.stdout.write(JSON.stringify(out));
`;

interface Read {
  files: Record<string, string>;
  ids: Record<string, string>;
  refused: [string, string][];
  over?: boolean;
}

/** The role's output files from the clone, read in the sandbox; any refusal an `UnreadableHead`. */
export function readOutput(
  record: SessionRecord,
  box: string,
  env: NodeJS.ProcessEnv,
  max = MAX_OUTPUT,
): Map<string, Buffer> {
  const { files, folders } = outputPaths(record);
  const entries = [...files.map((f) => `f:${f}`), ...folders.map((d) => `d:${d}`)];
  return committable(record, readClone(record, box, env, entries, 'sha1', max));
}

/** `entries` read in the sandbox by `READER`; past `max` bytes an `UnreadableHead`. */
function readClone(
  record: SessionRecord,
  box: string,
  env: NodeJS.ProcessEnv,
  entries: readonly string[],
  format: string,
  max: number,
): Read {
  // On stdin: a head with many test files would pass the command line's limit.
  const command = [process.execPath, '-e', READER, record.clone, String(max), format];
  const out = inBox(command, record.clone, box, env, {
    input: entries.join('\0'),
    limit: 2 * max + 8 * 1024 * 1024,
    name: 'reading its output',
  });
  const read = JSON.parse(out.toString()) as Read;
  if (read.over === true)
    throw new UnreadableHead(
      `its output holds more than the ${String(max)} bytes a role may write`,
    );
  return read;
}

/** The files read, as they would be committed; any refusal an `UnreadableHead`. */
function committable(record: SessionRecord, read: Read): Map<string, Buffer> {
  const policy = installedPolicy();
  const denied = deniedWrites(policy, record.role).concat(
    policy.denyRead.filter((pattern) => !pattern.startsWith('~/')),
  );
  const bad = [
    ...read.refused.map(([path, why]) => `${path} (${why})`),
    ...Object.keys(read.files).flatMap((path) => {
      const why = refusal(path, denied);
      return why === undefined ? [] : [`${path} (${why})`];
    }),
  ];
  if (bad.length > 0)
    throw new UnreadableHead(`its output cannot be committed: ${visible(bad.join(', '))}`);
  return new Map(
    Object.entries(read.files).map(([path, b64]) => [path, Buffer.from(b64, 'base64')]),
  );
}

/**
 * The paths git sees changed in the clone outside the role's own, from its status in the sandbox.
 * The clone's own attributes can still run a clean or process filter there, inside the box, so the
 * session can make its status lie, fail or slow down: it only names paths, nothing is committed
 * from it, and its failure never decides the output.
 */
export function outsideChanges(
  record: SessionRecord,
  box: string,
  env: NodeJS.ProcessEnv,
  mine?: (path: string) => boolean,
) {
  // The clone's config can name a command for git to run, and a submodule folder has its own.
  const off = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
  const args = [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
    '--ignore-submodules=all',
  ];
  const status = inSandbox(['--no-optional-locks', ...off, ...args], record.clone, box, env, {
    name: 'git status',
    limit: MAX_STATUS,
    over: `its git status lists more than the ${String(MAX_STATUS)} bytes the factory reads`,
  });
  const changed = status
    .toString()
    .split('\0')
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3));
  return changed.filter((path) => !(mine ?? ownPaths(record))(path));
}

/** Whether a path is one of the role's own, by its write column. */
function ownPaths(record: SessionRecord) {
  const { files, folders } = outputPaths(record);
  return (path: string) =>
    files.includes(path) || folders.some((folder) => matchesPath(`${folder}/**`, path));
}

/**
 * Where Test's walk starts: each include pattern's fixed folders, before its first glob character,
 * one inside another kept once; `` is the whole clone.
 */
export function walkRoots(include: readonly string[] = TEST_CONFIG.include): string[] {
  const roots = include.map((pattern) => {
    const parts = pattern.split('/').slice(0, -1);
    // An extglob part, such as @(a|b), is a pattern, never a folder.
    const glob = parts.findIndex((part) => /[*?[\]{}!()@+|]/.test(part));
    return parts.slice(0, glob < 0 ? parts.length : glob).join('/');
  });
  const inside = (r: string, o: string) => o !== r && (o === '' || r.startsWith(`${o}/`));
  return [...new Set(roots)].filter((r) => !roots.some((o) => inside(r, o)));
}

/**
 * Every path under the include patterns' roots Test's walk reads, in the sandbox, and the head's
 * gitlink folders the session put anything in; past `max` entries, or a path it cannot read, an
 * `UnreadableHead`.
 */
export function walkClone(
  record: SessionRecord,
  box: string,
  env: NodeJS.ProcessEnv,
  max = MAX_WALK,
  gitlinks: readonly string[] = [],
  roots = walkRoots(),
): { paths: string[]; held: string[] } {
  const command = [process.execPath, '-e', WALKER, record.clone, String(max)];
  const out = inBox(command, record.clone, box, env, {
    input: [...roots.map((r) => `r:${r}`), ...gitlinks.map((g) => `s:${g}`)].join('\0'),
    limit: 64 * 1024 * 1024,
    name: 'walking its clone',
    over: 'its clone lists more paths than the factory reads',
  });
  const walked = JSON.parse(out.toString()) as {
    paths: string[];
    held: string[];
    over?: boolean;
    failed?: [string, string, string];
  };
  if (walked.over === true)
    throw new UnreadableHead(
      `its clone holds more than the ${String(max)} entries the factory walks for Test's output, under ${roots.map((r) => (r === '' ? '/' : `${r}/`)).join(', ')} outside .git and node_modules`,
    );
  if (walked.failed !== undefined) {
    const [path, code, way] = walked.failed;
    throw new UnreadableHead(
      `the factory could not read ${visible(path === '' ? '/' : path)} in its clone for Test's output (${visible(code)}): ${way}`,
    );
  }
  return { paths: walked.paths, held: walked.held };
}

/**
 * The paths git could not add on the head's tree: a file, folder or submodule there or above, the
 * head's gitlink folders the session wrote in, and a path that differs from the head's only in
 * letter case, which a case-folding file system would overwrite.
 */
function clashes(
  paths: readonly string[],
  tree: ReadonlyMap<string, unknown>,
  held: readonly string[],
): string[] {
  const folders = new Set<string>();
  const lower = new Map<string, string>();
  for (const path of tree.keys()) {
    lower.set(path.toLowerCase(), path);
    for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
      folders.add(path.slice(0, at));
      lower.set(path.slice(0, at).toLowerCase(), path.slice(0, at));
    }
  }
  const bad = held.map(
    (folder) => `${folder} (the head has a submodule there; remove what is in it)`,
  );
  for (const path of paths) {
    const parts = path.split('/');
    const above = parts.slice(0, -1).some((_, i) => tree.has(parts.slice(0, i + 1).join('/')));
    const other = lower.get(path.toLowerCase());
    if (above || folders.has(path))
      bad.push(`${path} (the head has a file, folder or submodule there; remove it)`);
    else if (other !== undefined)
      bad.push(
        `${path} (the head has ${other}, which a case-folding file system would overwrite; rename it)`,
      );
  }
  return bad;
}

/** Where vitest writes the snapshots of the test file at `path`. */
const snapshotOf = (path: string) => {
  const at = path.lastIndexOf('/');
  return `${path.slice(0, at + 1)}__snapshots__/${path.slice(at + 1)}.snap`;
};

/**
 * Test's output: the test files it added, by the installed patterns, absent from the head and the
 * record's `tests`, with a snapshot only beside one. Existing test files are compared by blob id,
 * computed in the sandbox, so their bytes never leave it; one changed or deleted is refused.
 */
export function testOutput(
  record: SessionRecord,
  box: string,
  env: NodeJS.ProcessEnv,
): Map<string, Buffer> {
  const { project: repo, head } = record;
  const tree = new Map<string, { mode: string; oid: string }>();
  for (const entry of ownOk(repo, ['ls-tree', '-r', '-z', '--full-tree', head], env).split('\0')) {
    const tab = entry.indexOf('\t');
    const [mode = '', , oid = ''] = entry.slice(0, tab).split(' ');
    if (tab > 0) tree.set(entry.slice(tab + 1), { mode, oid });
  }
  const unknown = record.tests.filter((path) => !tree.has(path));
  if (unknown.length > 0)
    throw new EnvironmentError(
      `the session's record names tests its head ${head.slice(0, 12)} does not have, ${visible(unknown.join(', '))}: the factory's own error, which this session cannot fix`,
    );
  const existing = [...tree]
    .filter(([path, e]) => (e.mode === '100644' || e.mode === '100755') && isTestFile(path))
    .map(([path]) => path);
  const gitlinks = [...tree].filter(([, e]) => e.mode === '160000').map(([path]) => path);
  const { paths: walked, held } = walkClone(record, box, env, MAX_WALK, gitlinks);
  const here = new Set(walked);
  const added = walked.filter((path) => isTestFile(path) && !tree.has(path));
  const snapshots = added.map(snapshotOf).filter((path) => here.has(path) && !tree.has(path));
  // git's update-index would fail on these, as the factory's own error.
  const clash = clashes([...added, ...snapshots], tree, held);
  if (clash.length > 0)
    throw new UnreadableHead(`its output cannot be committed: ${visible(clash.join(', '))}`);
  const format = ownOk(repo, ['rev-parse', '--show-object-format'], env);
  const entries = [
    ...existing.map((path) => `h:${path}`),
    ...[...added, ...snapshots].map((path) => `f:${path}`),
  ];
  const read = readClone(record, box, env, entries, format, MAX_OUTPUT);
  const restore = existing.filter((path) => read.ids[path] !== tree.get(path)?.oid);
  if (restore.length > 0)
    throw new UnreadableHead(
      `an existing test file changed or deleted, never committed: ${visible(restore.join(', '))}; restore it; Test's output is only new test files`,
    );
  return committable(record, read);
}

/** What changed outside the role's paths, or why the factory could not list it. */
export interface Outside {
  outside: string[];
  unlisted?: string;
}

/** The factory's own name for a role's commits, never the Owner's. */
const author = (role: RoleName) => ({ name: `Factory ${role}`, email: `${role}@factory.invalid` });

/**
 * The commit of `files` on the record's head in the factory's own clone, or that head when they
 * change nothing.
 */
export function commitOutput(
  record: SessionRecord,
  files: ReadonlyMap<string, Buffer>,
  work: string,
  env: NodeJS.ProcessEnv,
): string {
  const { project: repo, head, role } = record;
  const who = author(role);
  const more = {
    env: {
      GIT_INDEX_FILE: join(work, 'index'),
      ...{ GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email },
      ...{ GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email },
    },
  };
  ownOk(repo, ['read-tree', head], env, more);
  for (const [path, bytes] of files) {
    const blob = ownBlob(repo, bytes, env);
    ownOk(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], env, more);
  }
  const tree = ownOk(repo, ['write-tree'], env, more);
  if (tree === ownOk(repo, ['rev-parse', `${head}^{tree}`], env)) return head;
  const item = basename(record.feature);
  const message = `${who.name}: station ${String(record.station)} output\n\nFactory-Role: ${role}\nFactory-Item: ${item}\n`;
  // The clone's own config would set the commit's encoding header.
  const commit = ['commit-tree', '--no-gpg-sign', tree, '-p', head, '-m', message];
  return ownOk(repo, ['-c', 'i18n.commitEncoding=UTF-8', ...commit], env, more);
}

/** A blob of `bytes` in the factory's clone, as they are: no filters, no attributes. */
function ownBlob(repo: string, bytes: Buffer, env: NodeJS.ProcessEnv): string {
  const result = own(repo, ['hash-object', '-w', '--stdin'], env, {}, bytes);
  if (result.status !== 0)
    throw new EnvironmentError(`git hash-object in ${repo} failed: ${result.err}`);
  return result.out;
}

/**
 * A hook-committing role's output, committed in the factory's own clone and kept under the
 * session ref, as `sessionOutput` keeps a session's own commits; the clone's HEAD must still be
 * the head it was issued, since the role commits nothing itself. `outside` names what changed
 * elsewhere.
 */
export function hookOutput(
  record: SessionRecord,
  home: string,
  session: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionOutput & Outside {
  const { project: repo, clone, head } = record;
  const work = mkdtempSync(join(sessionFolder(home, session), 'commit-'));
  try {
    const box = join(work, 'box');
    mkdirSync(box);
    const rev = ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'];
    const tip = inSandbox(rev, clone, box, env).toString().trim();
    if (tip !== head)
      throw new UnreadableHead(
        `a ${record.role} session commits nothing itself, but its clone's HEAD is ${visible(tip.slice(0, 12))}, not ${head.slice(0, 12)}, the commit it was issued; this session cannot fix it, so it ends as a failure`,
      );
    const files =
      record.role === 'test' ? testOutput(record, box, env) : readOutput(record, box, env);
    const commit = commitOutput(record, files, work, env);
    swapRef(repo, sessionRef(session), commit, env);
    const output = { repo, commit, head, feature: record.feature, branch: record.branch };
    try {
      const mine = record.role === 'test' ? (path: string) => files.has(path) : undefined;
      return { ...output, outside: outsideChanges(record, box, env, mine) };
    } catch (err) {
      if (!(err instanceof UnreadableHead)) throw err;
      return { ...output, outside: [], unlisted: err.message };
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
