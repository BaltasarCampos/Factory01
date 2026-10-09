// The safe diff (T138, research R18, data-model.md § Pull request merge checks): what changed
// between two commits, as the commits hold it. A pull request controls its own `.gitattributes`
// and a CI checkout's working tree, so nothing here may depend on them:
// - files are listed by `git diff-tree -r -z --no-renames`, which reads no attributes, so a
//   rename is a deletion plus an addition;
// - lines come from blob-to-blob diffs with `--text --no-ext-diff --no-textconv`, so no `-diff`,
//   `binary`, textconv or external driver can hide them;
// - file types and the append-only test read the blob bytes themselves.
// Nor may the user's git settings: every call runs without the global and system config, with
// an explicit algorithm, context and no colour, so the laptop and CI see the same lines.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { RefusedError } from '../cli/env.js';

export type EntryType = 'regular' | 'binary' | 'symlink' | 'gitlink';

export interface Line {
  /** 1-based line number on its side of the diff. */
  line: number;
  text: string;
}

export interface FileChange {
  path: string;
  /** A type change (file ↔ symlink, …) is `modified`, with both modes. */
  status: 'added' | 'deleted' | 'modified';
  oldMode?: string;
  newMode?: string;
  oldOid?: string;
  newOid?: string;
  /** The least regular of the two sides: a symlink or gitlink on either, else binary on either. */
  type: EntryType;
  /** Any file whose name starts with `.git` (`.gitattributes`, `.gitmodules`, …). */
  gitFile: boolean;
  /** Lines of a `regular` file only; empty for every other type. */
  added: Line[];
  removed: Line[];
}

const SYMLINK = '120000';
const GITLINK = '160000';

/**
 * Git without the global and system config, attributes files or an external diff. Every
 * inherited `GIT_*` variable is dropped first: `GIT_CONFIG_PARAMETERS` and `GIT_CONFIG_COUNT`
 * add config past `GIT_CONFIG_GLOBAL`, `GIT_DIFF_OPTS` overrides `-U`, and `GIT_DIR`,
 * `GIT_INDEX_FILE` or `GIT_OBJECT_DIRECTORY` could point at another repository. Dropping the
 * global config also drops a CI runner's `safe.directory`, so the repository is named on the
 * command line, which git counts as protected configuration.
 */
export function safeGit(
  repo: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  input?: string,
) {
  const clean = Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith('GIT_')),
  );
  const result = spawnSync(
    'git',
    [
      ...['-c', `safe.directory=${realpathSync(repo)}`, '-c', 'core.attributesFile=/dev/null'],
      ...['-c', 'core.quotePath=false', ...args],
    ],
    {
      cwd: repo,
      env: {
        ...clean,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ATTR_NOSYSTEM: '1',
      },
      maxBuffer: 1024 * 1024 * 1024,
      ...(input === undefined ? {} : { input }),
    },
  );
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr.toString().trim() };
}

function git(repo: string, args: readonly string[], env: NodeJS.ProcessEnv): Buffer {
  const result = safeGit(repo, args, env);
  if (result.status !== 0) throw new RefusedError(`git ${args[0] ?? ''} failed: ${result.stderr}`);
  return result.stdout;
}

/** The commit a ref names; refuses anything that could be read as an option. */
export function resolveCommit(repo: string, ref: string, env = process.env): string {
  if (ref === '' || ref.startsWith('-')) throw new RefusedError(`not a commit: ${ref}`);
  const result = safeGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], env);
  if (result.status !== 0) throw new RefusedError(`not a commit: ${ref}`);
  return result.stdout.toString().trim();
}

/** Where a pull request's changes start: the merge base of `base` and `head`. */
export function mergeBase(repo: string, base: string, head: string, env = process.env): string {
  const from = resolveCommit(repo, base, env);
  const to = resolveCommit(repo, head, env);
  const found = safeGit(repo, ['merge-base', from, to], env);
  if (found.status !== 0) throw new RefusedError(`${from} and ${to} share no history`);
  return found.stdout.toString().trim();
}

/** A file's bytes at a commit, or undefined when the commit has no such file. */
export function fileAt(repo: string, commit: string, path: string, env = process.env) {
  const found = safeGit(repo, ['cat-file', 'blob', `${commit}:${path}`], env);
  return found.status === 0 ? found.stdout : undefined;
}

const blob = (repo: string, oid: string, env: NodeJS.ProcessEnv) =>
  git(repo, ['cat-file', 'blob', oid], env);

/** Text the factory may read line by line: no NUL byte, valid UTF-8. */
function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function lines(bytes: Buffer): Line[] {
  const text = bytes.toString('utf8');
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return text === '' ? [] : parts.map((t, i) => ({ line: i + 1, text: t }));
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Added and removed lines between two text blobs, by a diff that sees no path. */
function lineDiff(repo: string, oldOid: string, newOid: string, env: NodeJS.ProcessEnv) {
  const patch = git(
    repo,
    [
      ...['diff', '--text', '--no-ext-diff', '--no-textconv', '--no-color'],
      ...['--diff-algorithm=myers', '--no-indent-heuristic', '-U0', oldOid, newOid],
    ],
    env,
  ).toString('utf8');
  const added: Line[] = [];
  const removed: Line[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const row of patch.split('\n')) {
    const hunk = HUNK.exec(row);
    if (hunk !== null) {
      [oldLine, newLine] = [Number(hunk[1]), Number(hunk[2])];
      inHunk = true;
    } else if (!inHunk) continue;
    else if (row.startsWith('-')) removed.push({ line: oldLine++, text: row.slice(1) });
    else if (row.startsWith('+')) added.push({ line: newLine++, text: row.slice(1) });
    else if (row.startsWith(' ')) [oldLine, newLine] = [oldLine + 1, newLine + 1];
  }
  return { added, removed };
}

const STATUS = { A: 'added', D: 'deleted', M: 'modified', T: 'modified' } as const;

export function safeDiff(
  repo: string,
  base: string,
  head: string,
  env: NodeJS.ProcessEnv = process.env,
): FileChange[] {
  const from = resolveCommit(repo, base, env);
  const to = resolveCommit(repo, head, env);
  const raw = git(repo, ['diff-tree', '-r', '-z', '--no-renames', from, to], env)
    .toString('utf8')
    .split('\0');
  const changes: FileChange[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [oldMode = '', newMode = '', oldOid = '', newOid = '', letter = ''] = (raw[i] ?? '')
      .replace(/^:/, '')
      .split(' ');
    const path = raw[i + 1] ?? '';
    const status = STATUS[letter as keyof typeof STATUS] as FileChange['status'] | undefined;
    if (status === undefined) throw new RefusedError(`git diff-tree: unexpected status ${letter}`);
    const sides = [
      ...(status === 'added' ? [] : [{ mode: oldMode, oid: oldOid }]),
      ...(status === 'deleted' ? [] : [{ mode: newMode, oid: newOid }]),
    ];
    const modes = sides.map((s) => s.mode);
    const content = new Map<string, Buffer>();
    let type: EntryType = 'regular';
    if (modes.includes(SYMLINK)) type = 'symlink';
    else if (modes.includes(GITLINK)) type = 'gitlink';
    else {
      for (const s of sides) content.set(s.oid, blob(repo, s.oid, env));
      if ([...content.values()].some((b) => !isText(b))) type = 'binary';
    }
    let added: Line[] = [];
    let removed: Line[] = [];
    if (type === 'regular') {
      if (status === 'added') added = lines(content.get(newOid) ?? Buffer.alloc(0));
      else if (status === 'deleted') removed = lines(content.get(oldOid) ?? Buffer.alloc(0));
      else if (oldOid !== newOid) ({ added, removed } = lineDiff(repo, oldOid, newOid, env));
    }
    changes.push({
      path,
      status,
      ...(status === 'added' ? {} : { oldMode, oldOid }),
      ...(status === 'deleted' ? {} : { newMode, newOid }),
      type,
      gitFile: posix.basename(path).startsWith('.git'),
      added,
      removed,
    });
  }
  return changes;
}

/**
 * True when the head content starts with the base content byte for byte, and a base whose last
 * line was cut short (no newline) is continued on a new line, not extended.
 */
export function appendOnly(repo: string, change: FileChange, env = process.env): boolean {
  if (change.status === 'deleted' || change.type !== 'regular' || change.newOid === undefined)
    return false;
  const before = change.oldOid === undefined ? Buffer.alloc(0) : blob(repo, change.oldOid, env);
  const after = blob(repo, change.newOid, env);
  if (!after.subarray(0, before.length).equals(before)) return false;
  return before.length === 0 || before.at(-1) === 0x0a || after.at(before.length) === 0x0a;
}
