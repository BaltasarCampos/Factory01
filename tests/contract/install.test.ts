// Contract rows for the clone's install (T061, slice 28-4d; Owner decision 2026-11-11), run for
// real with bubblewrap and pasta, as tests/contract/network.test.ts is: npm ci runs on a
// read-only clone with only its node_modules writable, and never on a clone whose lockfile fails
// the identity rule or that has a node_modules of its own.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attached } from '../../src/ci/network.js';
import * as deps from '../../src/dispatcher/launcher/deps.js';
import { makeRepo, type TestRepo } from '../helpers/git-repo.js';
import { tempDir } from '../helpers/keys.js';

const RUN = 180_000;
const outer: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' };
const git = realpathSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim());
const ROOT = { name: 'x', version: '1.0.0' };
/** A clone with a package.json and a lockfile of `packages` besides the root. */
const clone = (packages: Record<string, unknown> = {}, dependencies = {}) =>
  makeRepo({
    files: {
      'package.json': JSON.stringify({ ...ROOT, dependencies }),
      'package-lock.json': JSON.stringify({
        ...{ ...ROOT, lockfileVersion: 3 },
        packages: { '': { ...ROOT, dependencies }, ...packages },
      }),
    },
  });

/** Every path under `dir` but `skip`, with its mode and, for a file, its content's hash. */
const snapshot = (dir: string, skip = '\0') =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => path !== skip && !path.startsWith(`${skip}/`))
    .sort()
    .map((path) => {
      const stat = lstatSync(join(dir, path));
      const bytes = stat.isFile() ? readFileSync(join(dir, path)) : '';
      return `${path} ${String(stat.mode)} ${createHash('sha256').update(bytes).digest('hex')}`;
    });

/** The launcher's install on `repo` with the real sandbox, and how many times npm ran. */
function install(repo: TestRepo) {
  const runs: string[] = [];
  const result = deps.installDependencies(
    repo.path,
    realpathSync(tempDir()),
    git,
    outer,
    (...a) => {
      runs.push(a[0]);
      return deps.sandboxedInstall(outer)(...a);
    },
  );
  return { result, runs };
}

describe("the clone's install, for real (T061)", () => {
  it(
    'runs npm ci on a lockfile with no dependencies to status 0, leaving the clone otherwise unchanged',
    () => {
      const repo = clone();
      const before = snapshot(repo.path);
      expect(install(repo)).toEqual({ result: undefined, runs: [repo.path] });
      // npm ci worked with node_modules as the sandbox's one writable mount point in the clone.
      expect(lstatSync(join(repo.path, 'node_modules')).isDirectory()).toBe(true);
      expect(snapshot(repo.path, 'node_modules')).toEqual(before);
    },
    RUN,
  );

  it(
    'lets the install write only node_modules and its own folder: not the clone, its .git or the rest of the temporary folder',
    () => {
      const repo = makeRepo({ files: { 'package.json': '{}\n' } });
      const tmp = realpathSync(tempDir());
      const dirs = ['node_modules', '.git/x'].map((d) => join(repo.path, d));
      for (const dir of [...dirs, join(tmp, 'x'), join(tmp, 'npm-install', 'npm-cache')])
        mkdirSync(dir, { recursive: true });
      const { args } = deps.installArgs(repo.path, tmp, git);
      const writes = (path: string) =>
        attached(args, ['/bin/sh', '-c', `echo x > '${path}'`], undefined, outer, 'no pasta')
          .status === 0;
      expect(writes(join(repo.path, 'node_modules', 'ok'))).toBe(true);
      expect(writes(join(tmp, 'npm-install', 'npm-cache', 'ok'))).toBe(true);
      for (const path of ['probe', '.git/config', '.git/x/probe'].map((p) => join(repo.path, p)))
        expect(writes(path), path).toBe(false);
      expect(writes(join(tmp, 'x', 'probe'))).toBe(false);
    },
    RUN,
  );

  it(
    "never runs npm on a clone whose node_modules is a symlink, and leaves the link's target untouched",
    () => {
      const repo = clone();
      mkdirSync(join(repo.path, '.claude'));
      writeFileSync(join(repo.path, '.claude', 'settings.json'), 'kept\n');
      symlinkSync('.claude', join(repo.path, 'node_modules'));
      const before = snapshot(join(repo.path, '.claude'));
      const { result, runs } = install(repo);
      expect(result).toMatchObject({
        npm: false,
        why: expect.stringMatching(/of its own/) as string,
      });
      expect(runs).toEqual([]);
      expect(snapshot(join(repo.path, '.claude'))).toEqual(before);
    },
    RUN,
  );

  it(
    'never runs npm on a lockfile with a git dependency whose prepare script would write a marker',
    () => {
      // A git dependency's prepare runs under npm ci --ignore-scripts on npm 10.9.9.
      const marker = join(realpathSync(tempDir()), 'marker');
      const prepare = `node -e "require('fs').writeFileSync('${marker}', 'x')"`;
      const dep = makeRepo({
        files: {
          'package.json': JSON.stringify({ name: 'dep', version: '1.0.0', scripts: { prepare } }),
        },
      });
      const url = `git+file://${dep.path}`;
      const resolved = `${url}#${dep.git(['rev-parse', 'HEAD'])}`;
      const repo = clone({ 'node_modules/dep': { version: '1.0.0', resolved } }, { dep: url });
      const { result, runs } = install(repo);
      expect(result).toMatchObject({
        npm: false,
        why: expect.stringMatching(/resolves to "git\+file:/) as string,
      });
      expect(runs).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    },
    RUN,
  );
});
