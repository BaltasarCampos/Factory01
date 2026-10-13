// Contract tests for the files the factory writes and reads in the test workspace (T164, slice
// 23a-2; Owner decisions 2026-10-13), run in the real sandbox as sandbox.test.ts's are. Every
// sandboxed run can write anywhere in `work`, so a run can plant a link where a later run's
// config, tsconfig, results or coverage report will be: the later run refuses, and the file the
// link points at is neither written nor read. Each run's folder is made fresh by the factory, the
// install is read-only after its own run, and nothing a run leaves behind outlives it.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sandboxed } from '../../src/ci/sandbox.js';
import { testHead } from '../../src/ci/test.js';
import { installHead, inWorkspace } from '../../src/ci/vitest-run.js';
import { TEST_CONFIG } from '../../src/stations/edges.js';
import { gitEnv, makeRepo } from '../helpers/git-repo.js';
import { tempDir } from '../helpers/keys.js';

const RUN = 180_000;
const sandbox = { isolation: { sandbox: true as const }, config: TEST_CONFIG, env: gitEnv };

/** Results and coverage that would pass, kept under the real home, which no sandbox binds. */
const FORGED = {
  'config.mjs': 'export default { test: { include: ["nothing/**"] } };\n',
  'tsconfig.json': '{"compilerOptions":{"strict":false}}\n',
  'results.json': JSON.stringify({ testResults: [] }),
  'lcov.info': 'TN:\nSF:src/app.ts\nDA:1,1\nend_of_record\n',
};

let fixture = '';
beforeEach(() => {
  fixture = mkdtempSync(join(homedir(), '.factory-workspace-test-'));
  for (const [name, text] of Object.entries(FORGED)) writeFileSync(join(fixture, name), text);
});
afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

/** Every forged file is as it was: nothing was written through a link to it. */
function untouched() {
  for (const [name, text] of Object.entries(FORGED))
    expect(readFileSync(join(fixture, name), 'utf8')).toBe(text);
}

/** A head test file that plants `links` (relative to `work`) and passes. */
const PLANTER = (links: Record<string, string>, files: Record<string, string> = {}) => `
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { it } from 'vitest';
// The tree is work/<run>/tree, and the run's working folder.
const work = resolve(process.cwd(), '..', '..');
it('plants', () => {
  for (const [path, target] of Object.entries(${JSON.stringify(links)})) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    symlinkSync(target, join(work, path));
  }
  for (const [path, text] of Object.entries(${JSON.stringify(files)})) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }
});
`;

describe('a sandboxed run plants files where a later run will be (T164)', () => {
  it(
    'each later run refuses: its config, tsconfig, results and coverage report, and a base tree holding an extra test',
    () => {
      const links = {
        'config-run/config/vitest.config.mjs': join(fixture, 'config.mjs'),
        'tsconfig-run/tree/tsconfig.json': join(fixture, 'tsconfig.json'),
        'results-run/results.json': join(fixture, 'results.json'),
        'lcov-run/coverage/lcov.info': join(fixture, 'lcov.info'),
      };
      const repo = makeRepo({
        files: {
          'src/app.ts': 'export const one = 1;\n',
          'tests/plant.test.ts': PLANTER(links, {
            'base/tree/tests/extra.test.ts':
              "import { it } from 'vitest';\nit('extra', () => {});\n",
          }),
        },
      });
      const head = repo.revParse('HEAD');

      inWorkspace(repo.path, head, sandbox, (ws) => {
        ws.write('head', head);
        expect(ws.test('head').tests.map((t) => [t.name, t.status])).toEqual([
          ['plants', 'passed'],
        ]);

        const planted = /was already there: an earlier sandboxed run made it/;
        expect(() => ws.test('config-run')).toThrow(planted);
        expect(() => {
          ws.file('tsconfig-run', 'tsconfig.json', '{}');
        }).toThrow(planted);
        expect(() => ws.test('results-run')).toThrow(planted);
        expect(() => ws.test('lcov-run', true)).toThrow(planted);
        expect(() => ws.write('base', head)).toThrow(planted);
      });
      untouched();
    },
    RUN,
  );

  it(
    'the factory writes into a run’s folder only before the first run there',
    () => {
      const repo = makeRepo({ files: { 'tests/plant.test.ts': PLANTER({}) } });
      const head = repo.revParse('HEAD');

      inWorkspace(repo.path, head, sandbox, (ws) => {
        ws.write('head', head);
        ws.test('head');
        expect(() => ws.write('head', head)).toThrow(/only before the first run there/);
        expect(() => {
          ws.file('head', 'tsconfig.json', '{}');
        }).toThrow(/only before the first run there/);
        expect(() => ws.test('head')).toThrow(/only before the first run there/);
      });
    },
    RUN,
  );
});

describe('a run’s own results and coverage report are read only as regular files (T164)', () => {
  it.each([
    ['results.json', { 'head/results.json': 'results.json' }],
    ['lcov.info', { 'head/coverage/lcov.info': 'lcov.info' }],
  ])(
    'a %s the run replaced with a link refuses, and the file it points at is not read',
    (_, plant) => {
      const links = Object.fromEntries(
        Object.entries(plant).map(([path, name]) => [path, join(fixture, name)]),
      );
      const repo = makeRepo({
        files: { 'src/app.ts': 'export const one = 1;\n', 'tests/plant.test.ts': PLANTER(links) },
      });

      expect(() => testHead(repo.path, repo.revParse('HEAD'), sandbox)).toThrow(
        /is a link: refusing to read through it/,
      );
      expect(existsSync(join(repo.path, 'coverage'))).toBe(false);
      untouched();
    },
    RUN,
  );

  it(
    'factory ci test refuses a coverage folder in the checkout that is a link, and writes nothing through it',
    () => {
      const repo = makeRepo({
        files: { 'src/app.ts': 'export const one = 1;\n', 'tests/plant.test.ts': PLANTER({}) },
      });
      const outside = join(fixture, 'reports');
      mkdirSync(outside);
      symlinkSync(outside, join(repo.path, 'coverage'));

      expect(() => testHead(repo.path, repo.revParse('HEAD'), sandbox)).toThrow(/not a folder/);
      expect(readdirSync(outside)).toEqual([]);
    },
    RUN,
  );
});

describe('the install and what runs leave behind (T164)', () => {
  const LOCK = { name: 'p', version: '1.0.0', lockfileVersion: 3, requires: true };
  const PACKAGE = {
    'package.json': JSON.stringify({ name: 'p', version: '1.0.0' }),
    'package-lock.json': JSON.stringify({ ...LOCK, packages: { '': { name: 'p' } } }),
  };

  it(
    'after the install, every later run sees work/install read-only',
    () => {
      const repo = makeRepo({
        files: {
          ...PACKAGE,
          'tests/install.test.ts': `
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
it('cannot change the packages the next run loads', () => {
  expect(() => writeFileSync(resolve(process.cwd(), '..', '..', 'install', 'package.json'), '{}')).toThrow(/EROFS|EACCES/);
});
`,
        },
      });
      const head = repo.revParse('HEAD');

      inWorkspace(repo.path, head, sandbox, (ws) => {
        ws.write('head', head);
        expect(ws.test('head').tests.map((t) => t.status)).toEqual(['passed']);
      });
    },
    RUN,
  );

  it(
    'a run refuses when work/install is no longer a real folder, and binds nothing through it',
    () => {
      const repo = makeRepo({ files: PACKAGE });
      const work = realpathSync(tempDir());
      const run = sandboxed(work, gitEnv);
      installHead(repo.path, repo.revParse('HEAD'), work, run, gitEnv);
      rmSync(join(work, 'install'), { recursive: true });
      symlinkSync(fixture, join(work, 'install'));

      expect(() => run(['/bin/true'], work)).toThrow(/install is not a folder/);
    },
    RUN,
  );

  it(
    'a process a run leaves behind dies with it, so nothing writes into work afterwards',
    async () => {
      const work = realpathSync(tempDir());
      const late = "setsid sh -c 'sleep 1; echo late > late.txt' >/dev/null 2>&1 &";

      const result = sandboxed(work, gitEnv)(['/bin/sh', '-c', `${late} exit 0`], work);
      await sleep(2500);

      expect(result.status).toBe(0);
      expect(existsSync(join(work, 'late.txt'))).toBe(false);
    },
    RUN,
  );
});
