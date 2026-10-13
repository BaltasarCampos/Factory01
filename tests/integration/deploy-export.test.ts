// The export `factory deploy` builds from (T069, slice 23a; Owner decisions 2026-10-13): main's
// verified commit written without `.git` into a folder that did not exist, every folder and file
// first and the tree's links last, so no write passes through a link; and the release folders
// under the app folder. The same writer serves `writeTree`, which `merge` and `approve` use.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeTree } from '../../src/ci/vitest-run.js';
import { newRelease } from '../../src/deploy/release.js';
import { appFolder } from '../../src/deploy/sandbox.js';
import { exportTree } from '../../src/git/export.js';
import { gitEnv, makeRepo, runGit, type TestRepo } from '../helpers/git-repo.js';
import { tempDir } from '../helpers/keys.js';

const NOW = new Date('2026-10-13T15:30:00Z');
const STAMP = '20261013T153000Z';

/** Git with `input` on stdin. */
const gitIn = (repo: TestRepo, args: string[], input: string) =>
  execFileSync('git', args, { cwd: repo.path, env: gitEnv, encoding: 'utf8', input }).trim();
/** A commit of a hand-made tree: `rows` are `ls-tree` lines, written with `git mktree`. */
function crafted(repo: TestRepo, rows: string[]): string {
  const tree = gitIn(repo, ['mktree', '--missing'], `${rows.join('\n')}\n`);
  return runGit(repo.path, ['commit-tree', tree, '-m', 'crafted']);
}
const blob = (repo: TestRepo, text: string) => gitIn(repo, ['hash-object', '-w', '--stdin'], text);

function project(): TestRepo {
  const repo = makeRepo({
    files: { 'package.json': '{}\n', 'src/app.ts': 'export {};\n', 'bin/run.sh': 'echo\n' },
  });
  chmodSync(join(repo.path, 'bin', 'run.sh'), 0o755);
  repo.commit({}, 'executable');
  return repo;
}

describe('exportTree: the commit, without .git, into a new folder (T069)', () => {
  it('writes every file, keeps 100755 files executable, writes links as links, and no .git', () => {
    const repo = project();
    symlinkSync('app.ts', join(repo.path, 'src', 'link.ts'));
    const commit = repo.commit({}, 'link');
    const dir = join(tempDir(), 'release');

    exportTree(repo.path, commit, dir, gitEnv);

    expect(readFileSync(join(dir, 'src', 'app.ts'), 'utf8')).toBe('export {};\n');
    expect(statSync(join(dir, 'bin', 'run.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(dir, 'src', 'app.ts')).mode & 0o777).toBe(0o644);
    expect(readlinkSync(join(dir, 'src', 'link.ts'))).toBe('app.ts');
    expect(readdirSync(dir, { recursive: true }).map(String)).not.toContainEqual(
      expect.stringMatching(/(^|\/)\.git(\/|$)/),
    );
  });

  it('refuses a folder that already exists, and writes nothing into it', () => {
    const repo = project();
    const dir = tempDir();

    expect(() => {
      exportTree(repo.path, repo.revParse('HEAD'), dir, gitEnv);
    }).toThrow(/exists/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    ['a .git folder in another case', (r: TestRepo) => [`040000 tree ${gitTree(r)}\t.GIT`]],
    ['a ".." entry', (r: TestRepo) => [`100644 blob ${blob(r, 'x\n')}\t..`]],
    ['a submodule', (r: TestRepo) => [`160000 commit ${r.revParse('HEAD')}\tvendor`]],
  ])('refuses a tree holding %s, before writing anything', (_, rows) => {
    const repo = project();
    const commit = crafted(repo, rows(repo));
    const dir = join(tempDir(), 'release');

    expect(() => {
      exportTree(repo.path, commit, dir, gitEnv);
    }).toThrow(/refus|unsafe|submodule/);
    expect(existsSync(dir)).toBe(false);
  });

  it.each([
    [
      'exportTree',
      (r: TestRepo, c: string, d: string) => {
        exportTree(r.path, c, d, gitEnv);
      },
    ],
    [
      'writeTree, which merge and approve use',
      (r: TestRepo, c: string, d: string) => writeTree(r.path, c, d, () => true, gitEnv),
    ],
  ])(
    '%s refuses a tree holding a link and a folder of the same name, and writes nothing through the link',
    (_, write) => {
      const repo = project();
      const outside = tempDir();
      const commit = crafted(repo, [
        `120000 blob ${blob(repo, outside)}\tsrc`,
        `040000 tree ${gitTree(repo, 'key')}\tsrc`,
      ]);

      expect(() => {
        write(repo, commit, join(tempDir(), 'release'));
      }).toThrow(/both a link or file and a folder/);
      expect(readdirSync(outside)).toEqual([]);
    },
  );
});

describe('writeTree in a workspace a sandboxed run can write to (T164)', () => {
  it('refuses a tree folder that a run replaced with a link, and writes nothing through it', () => {
    const repo = project();
    const work = tempDir();
    const outside = tempDir();
    symlinkSync(outside, join(work, 'base'));

    expect(() =>
      writeTree(repo.path, repo.revParse('HEAD'), join(work, 'base', 'tree'), () => true, gitEnv),
    ).toThrow(/not a folder/);
    expect(readdirSync(outside)).toEqual([]);
  });
});

/** A tree holding one file, `name`. */
function gitTree(repo: TestRepo, name = 'config'): string {
  return gitIn(repo, ['mktree'], `100644 blob ${blob(repo, 'x\n')}\t${name}\n`);
}

describe('release folders under the app folder (T069)', () => {
  it('lives under ~/.local/share/factory/apps/<owner>/<repo>, with the settings under ~/.config', () => {
    const app = appFolder('/home/owner', 'owner/project');

    expect(app).toEqual({
      root: '/home/owner/.local/share/factory/apps/owner/project',
      releases: '/home/owner/.local/share/factory/apps/owner/project/releases',
      data: '/home/owner/.local/share/factory/apps/owner/project/data',
      backups: '/home/owner/.local/share/factory/apps/owner/project/backups',
      settings: '/home/owner/.config/factory/apps/owner/project/settings.env',
    });
  });

  it('exports each deploy into a new releases/<sha>-<deploy time> folder', () => {
    const repo = project();
    const app = appFolder(tempDir(), 'owner/project');
    const commit = repo.revParse('HEAD');

    const release = newRelease(app, repo.path, commit, NOW, gitEnv);

    expect(release).toBe(join(app.releases, `${commit}-${STAMP}`));
    expect(readFileSync(join(release, 'src', 'app.ts'), 'utf8')).toBe('export {};\n');
    for (const dir of [app.data, app.backups]) expect(lstatSync(dir).isDirectory()).toBe(true);
  });

  it('a redeploy of a commit writes nothing outside, though an old release of it holds src -> <outside folder>', () => {
    const repo = project();
    const app = appFolder(tempDir(), 'owner/project');
    const commit = repo.revParse('HEAD');
    const outside = tempDir();
    const planted = join(app.releases, `${commit}-${STAMP}`);
    mkdirSync(planted, { recursive: true });
    symlinkSync(outside, join(planted, 'src'));

    expect(() => newRelease(app, repo.path, commit, NOW, gitEnv)).toThrow(/exists/);
    const later = newRelease(app, repo.path, commit, new Date('2026-10-14T09:00:00Z'), gitEnv);

    expect(later).toBe(join(app.releases, `${commit}-20261014T090000Z`));
    expect(readdirSync(outside)).toEqual([]);
    expect(readlinkSync(join(planted, 'src'))).toBe(outside);
  });

  it.each(['releases', 'data', 'backups'] as const)(
    'refuses when the app folder’s %s is a link, writing nothing through it',
    (name) => {
      const repo = project();
      const app = appFolder(tempDir(), 'owner/project');
      const outside = tempDir();
      mkdirSync(app.root, { recursive: true });
      symlinkSync(outside, app[name]);

      expect(() => newRelease(app, repo.path, repo.revParse('HEAD'), NOW, gitEnv)).toThrow(
        /not a folder/,
      );
      expect(readdirSync(outside)).toEqual([]);
    },
  );
});
