// Contract tests for the safe diff library (T133, AC-082, data-model.md § Pull request merge
// checks): nothing the compared commits or the repository's config hold can change what it
// reports, renames are a deletion plus an addition, and every file type is named as it is.
import { execFileSync } from 'node:child_process';
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendOnly, safeDiff, type FileChange } from '../../src/git/diff.js';
import { gitEnv, makeRepo, runGit, type TestRepo } from '../helpers/git-repo.js';
import { tempDir } from '../helpers/keys.js';

const SOURCE = 'export const a = 1;\nexport const b = 2;\n';
const CHANGED = 'export const a = 1;\nexport const b = 3;\nexport const c = 4;\n';

/** A repository whose main holds `files`; returns it with main's commit. */
function repoWith(files: Record<string, string>) {
  const repo = makeRepo({ files });
  return { repo, base: repo.revParse('HEAD') };
}

const byPath = (changes: FileChange[], path: string) => changes.find((c) => c.path === path);

/** The plain diff of `src/a.ts` from SOURCE to CHANGED. */
function expectSourceChange(change: FileChange | undefined) {
  expect(change).toMatchObject({
    path: 'src/a.ts',
    status: 'modified',
    type: 'regular',
    removed: [{ line: 2, text: 'export const b = 2;' }],
    added: [
      { line: 2, text: 'export const b = 3;' },
      { line: 3, text: 'export const c = 4;' },
    ],
  });
}

describe('safeDiff (T138)', () => {
  it('reports status, modes, type and the added and removed lines of each file', () => {
    const { repo, base } = repoWith({ 'src/a.ts': SOURCE, 'old.md': 'gone\n' });
    const head = repo.commit({ 'src/a.ts': CHANGED, 'old.md': null, 'new.md': 'one\ntwo\n' }, 'c');

    const changes = safeDiff(repo.path, base, head);

    expect(changes.map((c) => [c.path, c.status]).sort()).toEqual([
      ['new.md', 'added'],
      ['old.md', 'deleted'],
      ['src/a.ts', 'modified'],
    ]);
    expectSourceChange(byPath(changes, 'src/a.ts'));
    expect(byPath(changes, 'new.md')).toMatchObject({
      newMode: '100644',
      added: [
        { line: 1, text: 'one' },
        { line: 2, text: 'two' },
      ],
      removed: [],
    });
    expect(byPath(changes, 'old.md')).toMatchObject({
      oldMode: '100644',
      added: [],
      removed: [{ line: 1, text: 'gone' }],
    });
  });

  it.each<[string, Record<string, string>]>([
    ['a .gitattributes marking sources -diff', { '.gitattributes': '*.ts -diff\n' }],
    ['a .gitattributes marking sources binary', { '.gitattributes': '* binary\n' }],
    [
      'a textconv filter in .gitattributes',
      { '.gitattributes': '*.ts diff=hide\n', '.git-hide.sh': '#!/bin/sh\necho hidden\n' },
    ],
  ])('%s changes nothing in the output', (_name, attributes) => {
    const { repo, base } = repoWith({ 'src/a.ts': SOURCE, ...attributes });
    repo.git(['config', 'diff.hide.textconv', `sh ${join(repo.path, '.git-hide.sh')}`]);
    const head = repo.commit({ 'src/a.ts': CHANGED }, 'c');

    expectSourceChange(byPath(safeDiff(repo.path, base, head), 'src/a.ts'));
  });

  it('an external diff command or driver in the repository config changes nothing', () => {
    const { repo, base } = repoWith({ 'src/a.ts': SOURCE, '.gitattributes': '*.ts diff=ext\n' });
    repo.git(['config', 'diff.external', 'true']);
    repo.git(['config', 'diff.ext.command', 'true']);
    repo.git(['config', 'diff.noprefix', 'true']);
    repo.git(['config', 'color.diff', 'always']);
    const head = repo.commit({ 'src/a.ts': CHANGED }, 'c');

    expectSourceChange(byPath(safeDiff(repo.path, base, head), 'src/a.ts'));
  });

  it('the user’s global git config changes nothing: colour, prefixes, algorithm, heuristics', () => {
    // Myers and histogram remove different lines here, and colour codes hide every `-` line.
    const { repo, base } = repoWith({ 'f.txt': 'c\nc\nd\nd\n' });
    const head = repo.commit({ 'f.txt': 'd\nc\nd\n' }, 'c');
    const global = join(tempDir(), 'gitconfig');
    writeFileSync(
      global,
      '[color]\n\tdiff = always\n[diff]\n\tnoprefix = true\n\talgorithm = histogram\n\tindentHeuristic = true\n',
    );
    const withGlobal = { ...gitEnv, GIT_CONFIG_GLOBAL: global };
    const plain = (env: NodeJS.ProcessEnv) =>
      execFileSync('git', ['diff', '-U0', base, head], { cwd: repo.path, env, encoding: 'utf8' });
    expect(plain(withGlobal)).not.toBe(plain(gitEnv));

    expect(safeDiff(repo.path, base, head, withGlobal)).toEqual(safeDiff(repo.path, base, head));
    expect(byPath(safeDiff(repo.path, base, head, withGlobal), 'f.txt')).toMatchObject({
      removed: [
        { line: 1, text: 'c' },
        { line: 2, text: 'c' },
      ],
      added: [{ line: 2, text: 'c' }],
    });
  });

  it('a rename is a deletion plus an addition', () => {
    const { repo, base } = repoWith({ 'src/a.ts': SOURCE });
    repo.git(['mv', 'src/a.ts', 'src/b.ts']);
    const head = repo.commit({}, 'rename');

    expect(
      safeDiff(repo.path, base, head)
        .map((c) => [c.path, c.status])
        .sort(),
    ).toEqual([
      ['src/a.ts', 'deleted'],
      ['src/b.ts', 'added'],
    ]);
  });

  it('reports binary files, symlinks, executable bits, gitlinks and .git* files as such', () => {
    const { repo, base } = repoWith({ 'run.sh': 'echo hi\n' });
    repo.commit({ 'blob.bin': 'a\0b\n', '.factory/ops/.gitattributes': '* -diff\n' }, 'files');
    chmodSync(join(repo.path, 'run.sh'), 0o755);
    symlinkSync('../run.sh', join(repo.path, 'link'));
    repo.git(['add', '-A']);
    repo.git(['update-index', '--add', '--cacheinfo', `160000,${base},vendor/lib`]);
    repo.git(['commit', '-q', '--no-gpg-sign', '-m', 'types']);
    const head = repo.revParse('HEAD');

    const changes = safeDiff(repo.path, base, head);

    expect(byPath(changes, 'blob.bin')).toMatchObject({ type: 'binary', added: [] });
    expect(byPath(changes, 'link')).toMatchObject({ type: 'symlink', newMode: '120000' });
    expect(byPath(changes, 'vendor/lib')).toMatchObject({ type: 'gitlink', newMode: '160000' });
    expect(byPath(changes, 'run.sh')).toMatchObject({
      status: 'modified',
      type: 'regular',
      oldMode: '100644',
      newMode: '100755',
      added: [],
      removed: [],
    });
    expect(byPath(changes, '.factory/ops/.gitattributes')).toMatchObject({
      type: 'regular',
      gitFile: true,
    });
    expect(byPath(changes, 'run.sh')?.gitFile).toBe(false);
  });

  it('reads paths with spaces, quotes and non-ASCII letters exactly', () => {
    const { repo, base } = repoWith({ 'a.md': 'x\n' });
    const head = repo.commit({ 'notes/ä "b" c.md': 'y\n' }, 'c');
    expect(safeDiff(repo.path, base, head).map((c) => c.path)).toEqual(['notes/ä "b" c.md']);
  });

  it('refuses a ref that is not a commit', () => {
    const { repo } = repoWith({ 'a.md': 'x\n' });
    expect(() => safeDiff(repo.path, 'HEAD', '--output=/tmp/x')).toThrow();
    expect(() => safeDiff(repo.path, 'HEAD', 'no-such-ref')).toThrow(/no-such-ref/);
  });
});

describe('appendOnly (T138, AC-082)', () => {
  function change(repo: TestRepo, before: string | null, after: string | null) {
    const base = repo.commit({ 'log.jsonl': before }, 'base', { allowEmpty: true });
    const head = repo.commit({ 'log.jsonl': after }, 'head', { allowEmpty: true });
    const found = byPath(safeDiff(repo.path, base, head), 'log.jsonl');
    if (found === undefined) throw new Error('log.jsonl did not change');
    return found;
  }

  it.each<[string, string | null, string | null, boolean]>([
    ['lines added at the end', 'a\nb\n', 'a\nb\nc\n', true],
    ['a new file', null, 'a\n', true],
    ['an edited line', 'a\nb\n', 'a\nB\nc\n', false],
    ['a deleted line', 'a\nb\n', 'a\n', false],
    ['a line inserted before existing lines', 'a\nb\n', 'z\na\nb\n', false],
    ['a deleted file', 'a\n', null, false],
    ['a last line cut short, continued on a new line', 'a\nb', 'a\nb\nc\n', true],
    ['a last line cut short, then extended', 'a\nb', 'a\nbc\n', false],
  ])('%s → %s', (_name, before, after, expected) => {
    const repo = makeRepo({ files: { 'README.md': 'r\n' } });
    expect(appendOnly(repo.path, change(repo, before, after))).toBe(expected);
  });

  it('compares bytes, not decoded text', () => {
    const repo = makeRepo({ files: { 'README.md': 'r\n' } });
    // The same characters in a different normal form are different bytes.
    const found = change(repo, 'café\n', 'café\nmore\n');
    expect(appendOnly(repo.path, found)).toBe(false);
    expect(runGit(repo.path, ['status', '--porcelain'])).toBe('');
  });
});
