// Contract tests for the laptop sandbox (T163, T164, design v1.8): outside GitHub Actions the
// pull request's tests and install run only inside bubblewrap. These run for real in the
// factory's own CI, which installs bubblewrap; they are never skipped when it is missing.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sandboxArgs, sandboxed } from '../../src/ci/sandbox.js';
import { installHead, runTests, writeTree } from '../../src/ci/vitest-run.js';
import { TEST_CONFIG } from '../../src/stations/edges.js';
import { gitEnv, makeRepo } from '../helpers/git-repo.js';
import { tempDir } from '../helpers/keys.js';

const FACTORY_MODULES = fileURLToPath(new URL('../../node_modules', import.meta.url));
const RUN = 120_000;

/** The pull request's test file: each test passes only if the sandbox holds. */
const PROBE = (fixture: string, port: number, outside: string[], hostTmp: string) => `
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { expect, it } from 'vitest';

it('reads nothing under the real home', () => {
  expect(() => readFileSync(${JSON.stringify(join(fixture, 'secret.txt'))})).toThrow();
});
it('has no agent socket', () => {
  expect(process.env.SSH_AUTH_SOCK).toBeUndefined();
  expect(existsSync('/run/user')).toBe(false);
});
it('reads nothing through the pull request links', () => {
  expect(() => readdirSync('tests/links/factory')).toThrow();
  expect(() => readFileSync('tests/links/fixture')).toThrow();
});
it('has no network', async () => {
  const attempt = new Promise((ok, fail) => {
    const socket = connect(${String(port)}, '127.0.0.1', () => { socket.destroy(); ok('connected'); });
    socket.on('error', fail);
  });
  await expect(attempt).rejects.toThrow();
});
it('writes nowhere outside its temp folder', () => {
  for (const path of ${JSON.stringify(outside)}) expect(() => writeFileSync(path, 'x')).toThrow();
  // The sandbox's /tmp is its own: this write succeeds inside and never reaches the host's.
  writeFileSync(${JSON.stringify(hostTmp)}, 'x');
});
`;

describe('the laptop sandbox, from inside a sandboxed test file (T163)', () => {
  it(
    'hides the home folder, agent sockets, the network and every writable folder but its own, and the report comes back',
    async () => {
      const fixture = mkdtempSync(join(homedir(), '.factory-sandbox-test-'));
      const server = createServer().listen(0, '127.0.0.1');
      const outside = [
        join(fixture, 'written'),
        join(FACTORY_MODULES, `.sandbox-probe-${randomUUID()}`),
        '/etc/sandbox-probe',
      ];
      const hostTmp = join(tmpdir(), `factory-sandbox-probe-${randomUUID()}`);
      try {
        await once(server, 'listening');
        writeFileSync(join(fixture, 'secret.txt'), 'the Owner’s key\n');
        const { port } = server.address() as AddressInfo;
        const repo = makeRepo({
          files: { 'tests/probe.test.ts': PROBE(fixture, port, outside, hostTmp) },
        });
        mkdirSync(join(repo.path, 'tests', 'links'));
        symlinkSync(join(homedir(), '.factory'), join(repo.path, 'tests', 'links', 'factory'));
        symlinkSync(join(fixture, 'secret.txt'), join(repo.path, 'tests', 'links', 'fixture'));
        const head = repo.commit({}, 'links');
        const work = realpathSync(tempDir());
        writeTree(repo.path, head, join(work, 'tree'), () => true, gitEnv);
        const env = { ...gitEnv, SSH_AUTH_SOCK: join(fixture, 'agent.sock') };

        const result = runTests(
          join(work, 'tree'),
          join(work, 'run'),
          TEST_CONFIG,
          sandboxed(work, env),
        );

        expect(result.tests.map((t) => [t.name, t.status])).toEqual([
          ['reads nothing under the real home', 'passed'],
          ['has no agent socket', 'passed'],
          ['reads nothing through the pull request links', 'passed'],
          ['has no network', 'passed'],
          ['writes nowhere outside its temp folder', 'passed'],
        ]);
        for (const path of [...outside, hostTmp]) expect(existsSync(path)).toBe(false);
      } finally {
        server.close();
        for (const path of [fixture, ...outside, hostTmp])
          rmSync(path, { recursive: true, force: true });
      }
    },
    RUN,
  );

  it(
    'the install reads the project’s .npmrc with an empty environment: ${SECRET} never expands',
    () => {
      const secret = `factory-secret-${randomUUID()}`;
      const work = realpathSync(tempDir());
      const lock = { name: 'p', version: '1.0.0', lockfileVersion: 3, requires: true };
      const repo = makeRepo({
        files: {
          'package.json': JSON.stringify({ name: 'p', version: '1.0.0' }),
          'package-lock.json': JSON.stringify({ ...lock, packages: { '': { name: 'p' } } }),
          '.npmrc': `logs-dir=${work}/\${SECRET}\n`,
        },
      });
      const run = sandboxed(work, { ...gitEnv, SECRET: secret });

      installHead(repo.path, repo.revParse('HEAD'), work, run, gitEnv);

      const names = readdirSync(work, { recursive: true }).map(String);
      expect(names).toContain('${SECRET}');
      expect(names.filter((n) => n.includes(secret))).toEqual([]);
    },
    RUN,
  );
});

describe('the laptop sandbox fails closed (T164)', () => {
  it('without bwrap on PATH, or when its probe fails, refuses with the install hint and its error', () => {
    const work = realpathSync(tempDir());
    expect(() => sandboxed(work, { PATH: tempDir() })).toThrow(/sudo apt install bubblewrap/);
    const bin = tempDir();
    writeFileSync(
      join(bin, 'bwrap'),
      '#!/bin/sh\necho "bwrap: setting up uid map: Permission denied" >&2\nexit 1\n',
    );
    chmodSync(join(bin, 'bwrap'), 0o755);
    expect(() => sandboxed(work, { PATH: `${bin}:/usr/bin:/bin` })).toThrow(
      /sudo apt install bubblewrap.*setting up uid map: Permission denied/,
    );
  });

  it.each([false, true])(
    'the bwrap arguments (network %s) start a new session and bind nothing of $HOME',
    (network) => {
      const work = realpathSync(tempDir());
      const args = sandboxArgs(work, work, network);
      expect(args).toEqual(
        expect.arrayContaining(['--unshare-all', '--new-session', '--clearenv']),
      );
      expect(args.includes('--share-net')).toBe(network);
      const home = homedir();
      const sources = args.flatMap((a, i) =>
        /^--(?:ro-|dev-)?bind(?:-try)?$/.test(a) ? [args[i + 1] ?? ''] : [],
      );
      expect(sources.filter((s) => s === home || home.startsWith(`${s}/`) || s === '/')).toEqual(
        [],
      );
      expect(sources.filter((s) => s.startsWith('/run/user') || s === '/tmp')).toEqual([]);
    },
  );
});
