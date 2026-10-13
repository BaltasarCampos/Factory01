// Contract tests for the sandboxes' network (T069, T164, slice 23b-1; design v1.8, Owner
// decisions 2026-10-13), run for real in the factory's own CI, which installs bubblewrap and
// passt, and on the laptop with `npm run check:sandbox`. The install and the app get network only
// through pasta in attach mode; from inside every run the laptop's loopback and its local sockets
// are out of reach; the app's port answers only on the laptop's loopback; pasta never outlives a
// run, and a pasta that fails starts no command.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachCommand, attached, DNS_FORWARD } from '../../src/ci/network.js';
import { npmCli, sandboxArgs, sandboxed } from '../../src/ci/sandbox.js';
import { installHead } from '../../src/ci/vitest-run.js';
import { appFolder, deployRunner, type DeployRun } from '../../src/deploy/sandbox.js';
import { gitEnv, makeRepo } from '../helpers/git-repo.js';
import { tempDir } from '../helpers/keys.js';

const RUN = 120_000;
const PORT = 21_000 + (process.pid % 10_000);
const outer: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' };

/** A listener on the laptop's 127.0.0.1 and one on an abstract Unix socket. */
let laptop: Server;
let local: Server;
const ABSTRACT = `\0factory-test-${randomUUID()}`;
beforeAll(async () => {
  laptop = createServer((s) => s.end()).listen(0, '127.0.0.1');
  local = createServer((s) => s.end()).listen(ABSTRACT);
  await Promise.all([once(laptop, 'listening'), once(local, 'listening')]);
});
afterAll(() => {
  laptop.close();
  local.close();
});

/** What a run reaches, from inside it, as JSON on stdout. */
const REACH = () => `
const dns = require('node:dns');
const net = require('node:net');
const reach = (to) => new Promise((ok) => {
  const s = net.connect(to);
  s.setTimeout(5000);
  s.on('connect', () => { s.destroy(); ok(true); });
  s.on('error', () => ok(false));
  s.on('timeout', () => { s.destroy(); ok(false); });
});
// The default gateway, which pasta would map to the laptop's loopback without --no-map-gw.
const gateway = () => {
  const row = require('node:fs').readFileSync('/proc/net/route', 'utf8').split('\\n')
    .map((r) => r.split('\\t')).find((r) => r[1] === '00000000');
  return row === undefined ? undefined : Buffer.from(row[2], 'hex').reverse().join('.');
};
(async () => {
  const port = ${String((laptop.address() as AddressInfo).port)};
  const via = gateway();
  const lookup = () => new Promise((ok) => dns.lookup('registry.npmjs.org', (e, a) => ok(e ? '' : a)));
  // All at once: a dropped connection waits out its timeout.
  const [loopback, gatewayToLaptop, socket, viaDns, address] = await Promise.all([
    reach({ host: '127.0.0.1', port }),
    via === undefined ? false : reach({ host: via, port }),
    reach({ path: ${JSON.stringify(ABSTRACT)} }),
    // pasta's DNS address carries DNS and nothing else: not the laptop's listener.
    reach({ host: ${JSON.stringify(DNS_FORWARD)}, port }),
    lookup(),
  ]);
  const laptop = loopback || gatewayToLaptop;
  const internet = address !== '' && (await reach({ host: address, port: 443 }));
  console.log(JSON.stringify({ laptop, socket, dns: viaDns, internet }));
})();
`;

/** The app folder with a release, data, backups and a settings file, under a temp home. */
function layout(files: Record<string, string> = {}) {
  const app = appFolder(tempDir(), 'owner/project');
  const release = join(app.releases, `${'a'.repeat(40)}-20261013T153000Z`);
  for (const dir of [release, app.data, app.backups]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(app.settings, '..'), { recursive: true });
  writeFileSync(app.settings, 'TOKEN=settings\n');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(release, name), text);
  return { app, release };
}

const gone = (pid: number | undefined) => {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

/** A package with one dependency, locked: a real `npm ci` fetches it from the registry. */
const ONE_DEPENDENCY = {
  'package.json': JSON.stringify({
    name: 'p',
    version: '1.0.0',
    dependencies: { 'is-number': '7.0.0' },
  }),
  'package-lock.json': JSON.stringify({
    name: 'p',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'p', version: '1.0.0', dependencies: { 'is-number': '7.0.0' } },
      'node_modules/is-number': {
        version: '7.0.0',
        resolved: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
        integrity:
          'sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==',
      },
    },
  }),
};

describe('what each run reaches, from inside it (T069, T164)', () => {
  it.each([
    ['install', true],
    ['build', false],
    ['app', true],
    ['backup', false],
  ] as [DeployRun, boolean][])(
    'the deploy %s run: not the laptop’s 127.0.0.1, its abstract socket or its listener through the DNS address; the internet by name: %s',
    (run, internet) => {
      const { app, release } = layout();
      const result = deployRunner(
        app,
        release,
        outer,
        PORT,
      )(run, [process.execPath, '-e', REACH()]);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        laptop: false,
        socket: false,
        dns: false,
        internet,
      });
    },
    RUN,
  );

  it.each([
    ['install', true],
    ['test', false],
  ])(
    'the test sandbox’s %s run: not the laptop’s 127.0.0.1, its abstract socket or its listener through the DNS address; the internet by name: %s',
    (_, internet) => {
      const work = realpathSync(tempDir());
      const result = sandboxed(work, outer)([process.execPath, '-e', REACH()], work, internet);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        laptop: false,
        socket: false,
        dns: false,
        internet,
      });
    },
    RUN,
  );
});

describe('real installs and the app’s port (T069, T164)', () => {
  it(
    'the deploy install run fetches a locked dependency from the registry with npm ci',
    () => {
      const { app, release } = layout(ONE_DEPENDENCY);
      const npm = [
        realpathSync(process.execPath),
        npmCli(),
        'ci',
        '--ignore-scripts',
        '--no-audit',
      ];
      const result = deployRunner(app, release, outer, PORT)('install', npm);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(release, 'node_modules', 'is-number', 'package.json'))).toBe(true);
    },
    RUN,
  );

  it(
    'the test sandbox’s install fetches it too',
    () => {
      const repo = makeRepo({ files: ONE_DEPENDENCY });
      const work = realpathSync(tempDir());
      const install = installHead(
        repo.path,
        repo.revParse('HEAD'),
        work,
        sandboxed(work, outer),
        gitEnv,
      );
      expect(existsSync(join(install ?? '', 'is-number', 'package.json'))).toBe(true);
    },
    RUN,
  );

  it(
    'the app’s port answers on the laptop’s 127.0.0.1, and pasta listens for it nowhere else',
    async () => {
      const { app, release } = layout();
      const answers = join(tempDir(), 'answers.json');
      // The runner blocks this process while the app runs, so another one knocks.
      const client = spawn(process.execPath, [
        '-e',
        `
const net = require('node:net');
const knock = (host) => new Promise((ok) => {
  const s = net.connect(${String(PORT)}, host);
  s.on('data', (d) => { s.destroy(); ok(String(d).trim()); });
  s.on('error', () => ok(''));
  // pasta accepts on the laptop's side before the app listens, then closes.
  s.on('close', () => ok(''));
});
(async () => {
  let loopback = '';
  for (let i = 0; i < 50 && loopback === ''; i++) {
    loopback = await knock('127.0.0.1');
    if (loopback === '') await new Promise((r) => setTimeout(r, 200));
  }
  // Every listening socket on the port, IPv4 and IPv6, as its hex local address.
  const fs = require('node:fs');
  const port = ${JSON.stringify(PORT.toString(16).toUpperCase().padStart(4, '0'))};
  const listening = ['tcp', 'tcp6'].flatMap((t) => fs.readFileSync('/proc/net/' + t, 'utf8').split('\\n').slice(1)
    .map((r) => r.trim().split(/\\s+/)).filter((r) => r[1]?.endsWith(':' + port) && r[3] === '0A').map((r) => r[1]));
  fs.writeFileSync(${JSON.stringify(answers)}, JSON.stringify({ loopback, listening }));
})();
`,
      ]);
      const serve =
        "const server = require('node:net').createServer((s) => { s.end('app\\n'); " +
        'setTimeout(() => process.exit(0), 3000); }); ' +
        `server.listen(${String(PORT)}, '0.0.0.0'); setTimeout(() => process.exit(1), 30000);`;

      const result = deployRunner(
        app,
        release,
        outer,
        PORT,
      )('app', [process.execPath, '-e', serve]);
      await once(client, 'exit');

      expect(result.status).toBe(0);
      // 0100007F is 127.0.0.1 as /proc/net/tcp writes it.
      expect(JSON.parse(readFileSync(answers, 'utf8'))).toEqual({
        loopback: 'app',
        listening: [`0100007F:${PORT.toString(16).toUpperCase().padStart(4, '0')}`],
      });
    },
    RUN,
  );
});

/** The attach helper started as the runner starts it, without waiting: its reports on fd 3. */
function startHelper(argv: string[], env = outer, readyMs?: number) {
  const work = realpathSync(tempDir());
  const command = attachCommand(sandboxArgs(work, work), argv, undefined, readyMs);
  const helper = spawn(command.command, command.args, {
    env,
    stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
  });
  helper.stdin?.end(command.input);
  const reports: Record<string, unknown>[] = [];
  let text = '';
  (helper.stdio[3] as NodeJS.ReadableStream).on('data', (d: Buffer) => {
    text += d.toString();
    const lines = text.split('\n');
    text = lines.pop() ?? '';
    for (const line of lines) reports.push(JSON.parse(line) as Record<string, unknown>);
  });
  const exited = once(helper, 'exit');
  const report = async (key: string) => {
    for (let i = 0; i < 200 && !reports.some((r) => key in r); i++) await sleep(50);
    return reports.find((r) => key in r)?.[key];
  };
  return {
    helper,
    work,
    exited,
    report,
    done: () => {
      rmSync(command.dir, { recursive: true, force: true });
    },
  };
}

describe('pasta never outlives the sandbox (T069, T164)', () => {
  it('the helper runs under setpriv --pdeathsig KILL, so it dies with the factory process', () => {
    const command = attachCommand(['--unshare-all'], ['true'], undefined);
    rmSync(command.dir, { recursive: true, force: true });
    expect([command.command, ...command.args.slice(0, 3)]).toEqual([
      ...['setpriv', '--pdeathsig', 'KILL', '--'],
    ]);
  });

  it.each([
    ['passes', 'exit 0', 0],
    ['fails', 'exit 3', 3],
  ])(
    'after a run that %s, its pasta is gone',
    (_, script, status) => {
      const work = realpathSync(tempDir());
      const result = attached(
        sandboxArgs(work, work),
        ['/bin/sh', '-c', script],
        undefined,
        outer,
        'pasta failed',
      );
      expect(result.status).toBe(status);
      expect(result.pasta).toBeTypeOf('number');
      expect(gone(result.pasta)).toBe(true);
    },
    RUN,
  );

  it.each(['SIGKILL', 'SIGTERM'] as const)(
    'when the factory process running it gets %s, as when the service stops, nothing is left',
    async (signal) => {
      const run = startHelper(['/bin/sleep', '30']);
      const [bwrap, pasta] = [await run.report('bwrap'), await run.report('pasta')] as number[];
      expect(await run.report('ready')).toBe(true);

      run.helper.kill(signal);
      await run.exited;
      await sleep(1000);
      run.done();

      expect(gone(bwrap)).toBe(true);
      expect(gone(pasta)).toBe(true);
    },
    RUN,
  );
});

describe('the attach helper fails closed (T069, T164)', () => {
  /** A PATH whose pasta is the given script, ahead of the real one. */
  function fakePasta(script: string): NodeJS.ProcessEnv {
    const bin = tempDir();
    writeFileSync(join(bin, 'pasta'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, 'pasta'), 0o755);
    return { PATH: `${bin}:${outer.PATH ?? ''}` };
  }

  it.each([
    ['never becomes ready', 'exec sleep 60', /pasta was not ready/],
    ['exits at once', 'echo "pasta: cannot configure" >&2; exit 1', /pasta: cannot configure/],
  ])(
    'a pasta that %s leaves no bwrap or pasta behind and starts no command',
    async (_, script, said) => {
      const run = startHelper(['/bin/sh', '-c', 'echo started > started'], fakePasta(script), 1500);
      await run.exited;
      const [bwrap, pasta, refused] = [
        await run.report('bwrap'),
        await run.report('pasta'),
        await run.report('refused'),
      ];
      run.done();

      expect(String(refused)).toMatch(said);
      expect(gone(bwrap as number)).toBe(true);
      expect(gone(pasta as number)).toBe(true);
      expect(existsSync(join(run.work, 'started'))).toBe(false);
    },
    RUN,
  );

  it('the runner refuses with pasta’s own error', () => {
    const work = realpathSync(tempDir());
    expect(() =>
      attached(
        sandboxArgs(work, work),
        ['/bin/true'],
        undefined,
        fakePasta('echo "pasta: cannot configure" >&2; exit 1'),
        'the install gets network only through pasta, which failed',
      ),
    ).toThrow(/only through pasta, which failed.*pasta: cannot configure/s);
  });

  it('without passt both sandboxes refuse with the install hint, never sharing the network', () => {
    const bin = tempDir();
    for (const tool of ['bwrap', 'setpriv']) symlinkSync(`/usr/bin/${tool}`, join(bin, tool));
    const { app, release } = layout();
    const work = realpathSync(tempDir());

    expect(() => sandboxed(work, { PATH: bin })).toThrow(/sudo apt install passt/);
    expect(() => deployRunner(app, release, { PATH: bin }, PORT)).toThrow(/sudo apt install passt/);
  });
});
