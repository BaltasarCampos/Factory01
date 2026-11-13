// The Stop hook's commit for the roles that commit nothing themselves, Spec, Planner, the
// Reviewer and Security (T086, slice 28-5b). Their output files are read from the session's clone
// only inside the factory's read-only sandbox, each a regular file with no link on its path, and
// committed in the factory's own clone with plumbing: a temporary index on the head the session
// was issued, a fixed factory author per role, the `Factory-Role` and `Factory-Item` trailers and
// none of the Owner's git config. Only the role's own paths, from the installed `roles.yaml`, are
// ever read, so a change anywhere else is never committed.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EnvironmentError } from '../cli/env.js';
import { loadPolicy } from '../guard/policy.js';
import { isProtected } from '../install/manifest.js';
import { isPlainPath } from '../model/naming.js';
import type { RoleName } from '../model/types.js';
import { visible } from '../notify/summary.js';
import {
  inBox,
  inSandbox,
  own,
  ownOk,
  sessionRef,
  UnreadableHead,
  type SessionOutput,
} from './session-commits.js';
import { sessionFolder, type SessionRecord } from './session.js';

/** The roles whose output the Stop hook commits; Test's comes with 28-5b-2. */
export const HOOK_COMMITS: readonly RoleName[] = ['spec', 'planner', 'reviewer', 'security'];

/** The most a role's output may hold, in bytes, all its files together. */
export const MAX_OUTPUT = 8 * 1024 * 1024;

const POLICY = new URL('../../factory/policy/roles.yaml', import.meta.url);

/** The role's write column, the feature folder filled in: files, and folders a `/**` names. */
export function outputPaths(record: SessionRecord): { files: string[]; folders: string[] } {
  const policy = loadPolicy(readFileSync(POLICY, 'utf8'));
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
 * Run with node inside the sandbox: every file named, and every file under every folder named,
 * as base64, each checked from the clone's root down with lstat, so a link anywhere on its path,
 * or anything but a regular file or folder, is refused rather than followed; a missing one is
 * left out. Past `max` bytes in all it stops.
 */
const READER = `
const fs = require('node:fs');
const [clone, max, ...named] = process.argv.slice(1);
const out = { files: {}, refused: [] };
let total = 0;
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
const walk = (rel) => {
  for (const name of fs.readdirSync(clone + '/' + rel).sort()) {
    const at = rel + '/' + name, k = kind(at);
    if (k === 'folder') walk(at); else if (k === 'file') read(at); else if (k !== 'missing') out.refused.push([at, k]);
  }
};
for (const entry of named) {
  const [type, rel] = [entry.slice(0, 2), entry.slice(2)], k = kind(rel);
  if (k === 'missing') continue;
  if (type === 'f:' && k === 'file') read(rel);
  else if (type === 'd:' && k === 'folder') walk(rel);
  else out.refused.push([rel, k === 'folder' ? 'a folder' : k === 'file' ? 'not a folder' : k]);
}
process.stdout.write(JSON.stringify(out));
`;

interface Read {
  files: Record<string, string>;
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
  const command = [process.execPath, '-e', READER, record.clone, String(max), ...entries];
  const out = inBox(command, record.clone, box, env, {
    limit: 2 * max,
    name: 'reading its output',
  });
  const read = JSON.parse(out.toString()) as Read;
  if (read.over === true)
    throw new UnreadableHead(
      `its output holds more than the ${String(max)} bytes a role may write`,
    );
  const bad = [
    ...read.refused.map(([path, why]) => `${path} (${why})`),
    ...Object.keys(read.files)
      .filter((path) => !isPlainPath(path) || isProtected(path))
      .map((path) => `${path} (${isPlainPath(path) ? 'a protected path' : 'not a plain path'})`),
  ];
  if (bad.length > 0)
    throw new UnreadableHead(`its output cannot be committed: ${visible(bad.join(', '))}`);
  return new Map(
    Object.entries(read.files).map(([path, b64]) => [path, Buffer.from(b64, 'base64')]),
  );
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
  return ownOk(repo, ['commit-tree', '--no-gpg-sign', tree, '-p', head, '-m', message], env, more);
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
 * the head it was issued, since the role commits nothing itself.
 */
export function hookOutput(
  record: SessionRecord,
  home: string,
  session: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionOutput {
  const { project: repo, clone, head } = record;
  const work = mkdtempSync(join(sessionFolder(home, session), 'commit-'));
  try {
    const box = join(work, 'box');
    mkdirSync(box);
    const rev = ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'];
    const tip = inSandbox(rev, clone, box, env).toString().trim();
    if (tip !== head)
      throw new UnreadableHead(
        `a ${record.role} session commits nothing itself, but its clone's HEAD is ${visible(tip.slice(0, 12))}, not ${head.slice(0, 12)}, the commit it was issued: the factory commits its output`,
      );
    const files = readOutput(record, box, env);
    const commit = commitOutput(record, files, work, env);
    ownOk(repo, ['update-ref', sessionRef(session), commit], env);
    return { repo, commit, head, feature: record.feature, branch: record.branch };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
