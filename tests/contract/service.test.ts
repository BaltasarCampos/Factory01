// Contract tests for the app's systemd user service (T069, slice 23b-2a; Owner decisions
// 2026-10-13), run against a real user manager: in the factory's own CI, which starts one with
// `loginctl enable-linger`, and on the laptop with `npm run check:service`. Never skipped. The
// units go to $XDG_RUNTIME_DIR/systemd/user, enabled with --runtime, never into ~/.config; they
// run the CLI from the source, through vite-node, rather than whatever dist/ was last built.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { appFolder } from '../../src/deploy/sandbox.js';
import { lastBackup, switchService, unitName, unitRelease } from '../../src/deploy/service.js';
import { tempDir } from '../helpers/keys.js';

const RUN = 180_000;
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const PROGRAM = [
  realpathSync(process.execPath),
  join(ROOT, 'node_modules', 'vite-node', 'vite-node.mjs'),
  ...['--root', ROOT, join(ROOT, 'src', 'cli', 'main.ts')],
];
const place = { dir: join(process.env.XDG_RUNTIME_DIR ?? '', 'systemd', 'user'), runtime: true };
const env = process.env;
let nextPort = 24_000 + (process.pid % 2_000) * 3;

const systemctl = (...args: string[]) =>
  spawnSync('systemctl', ['--user', ...args], { env, encoding: 'utf8' });

/** An app folder under a temp home, with releases that serve on PORT or never listen. */
function project() {
  const home = realpathSync(tempDir());
  const repo = `owner/test-${randomUUID().slice(0, 8)}`;
  const app = appFolder(home, repo);
  for (const dir of [app.data, app.backups]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(app.settings, '..'), { recursive: true });
  writeFileSync(app.settings, 'TOKEN=settings\n', { mode: 0o600 });
  const unit = unitName(repo);
  const backup = unitName(repo, 'backup');
  const timer = unitName(repo, 'backup', 'timer');
  writeFileSync(join(home, 'secret'), 'the Owner’s');
  onTestFinished(() => {
    for (const name of [timer, backup, unit]) {
      systemctl('stop', name);
      systemctl('disable', '--runtime', name);
      rmSync(join(place.dir, name), { force: true });
    }
    systemctl('daemon-reload');
    systemctl('reset-failed', unit, backup);
  });
  let n = 0;
  const release = (serves: boolean) => {
    const name = `${(n++).toString(16).padStart(40, '0')}-20261013T15300${String(n)}Z`;
    const folder = join(app.releases, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, 'package.json'),
      JSON.stringify({
        ...{ name: 'p', version: '1.0.0' },
        scripts: { start: 'node server.mjs', backup: 'node backup.mjs' },
      }),
    );
    // Fails when the test leaves `fail` in the data folder; else records what reading a file
    // under the Owner's home gave it.
    writeFileSync(
      join(folder, 'backup.mjs'),
      `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
if (existsSync(process.env.APP_DATA + '/fail')) process.exit(3);
let saw;
try { saw = readFileSync(${JSON.stringify(join(home, 'secret'))}, 'utf8'); } catch (err) { saw = err.code; }
writeFileSync(process.env.APP_BACKUPS + '/made', saw);
`,
    );
    writeFileSync(
      join(folder, 'server.mjs'),
      serves
        ? "import { createServer } from 'node:http';\ncreateServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '0.0.0.0');\n"
        : 'setInterval(() => {}, 1000);\n',
    );
    return name;
  };
  const port = nextPort++;
  const spec = (name: string) => ({
    repo,
    release: name,
    port,
    home,
    factory: ROOT,
    program: PROGRAM,
  });
  const units = () =>
    [unit, backup, timer].map((name) =>
      existsSync(join(place.dir, name)) ? readFileSync(join(place.dir, name), 'utf8') : undefined,
    );
  return { repo, app, unit, backup, timer, release, spec, port, units };
}

/** Whether 127.0.0.1:<port> answers HTTP now. */
const answers = (port: number) =>
  new Promise<boolean>((ok) => {
    const req = request({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
      res.resume();
      ok(true);
    });
    req.on('error', () => {
      ok(false);
    });
    req.on('timeout', () => {
      req.destroy();
      ok(false);
    });
    req.end();
  });

/** Every process in the unit's cgroup, by name. */
function processes(unit: string): { pid: number; name: string }[] {
  const group = systemctl('show', '--property=ControlGroup', '--value', unit).stdout.trim();
  // cgroup v2 on GitHub's runners; v1, with systemd's own hierarchy, on Crostini.
  const procs = ['/sys/fs/cgroup', '/sys/fs/cgroup/systemd']
    .map((root) => join(root, group, 'cgroup.procs'))
    .find((path) => group !== '' && existsSync(path));
  if (procs === undefined) return [];
  return readFileSync(procs, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((pid) => ({
      pid: Number(pid),
      name: existsSync(`/proc/${pid}/comm`) ? readFileSync(`/proc/${pid}/comm`, 'utf8').trim() : '',
    }));
}
const alive = (pid: number) => existsSync(`/proc/${String(pid)}`);

describe('the app’s systemd user service, for real (T069)', () => {
  it(
    'runs the app through factory code, the helper and pasta; stopping it leaves no pasta or bwrap behind',
    async () => {
      const p = project();

      await switchService(place, p.spec(p.release(true)), env);

      expect(await answers(p.port)).toBe(true);
      const running = processes(p.unit);
      // Found by name only to take their PIDs, which an exec keeps: Ubuntu 24.04's passt
      // re-execs pasta as its AVX2 build, named pasta.avx2.
      const bwrap = running.filter((r) => r.name === 'bwrap').map((r) => r.pid);
      const pasta = running.filter((r) => /^pasta(\.avx2)?$/.test(r.name)).map((r) => r.pid);
      expect(bwrap.length).toBeGreaterThan(0);
      expect(pasta).toHaveLength(1);
      expect([...bwrap, ...pasta].every(alive)).toBe(true);
      expect(systemctl('stop', p.unit).status).toBe(0);
      await sleep(1000);
      expect([...bwrap, ...pasta].filter(alive)).toEqual([]);
      expect(running.filter((r) => alive(r.pid))).toEqual([]);
      // A stop is clean: the unit is inactive, not failed.
      expect(systemctl('is-failed', p.unit).stdout.trim()).toBe('inactive');
    },
    RUN,
  );

  it(
    'a release that never answers HTTP is switched back to the one before, which answers again',
    async () => {
      const p = project();
      const good = p.release(true);
      await switchService(place, p.spec(good), env);

      const before = p.units();
      await expect(switchService(place, p.spec(p.release(false)), env)).rejects.toThrow(
        `switched the service back to ${good}, and put the backup's units back as they were`,
      );

      // The app's unit and the backup's, both back as they were, and the timer running again.
      expect(p.units()).toEqual(before);
      expect(unitRelease(before[1] ?? '', p.repo, 'backup')).toBe(good);
      expect(systemctl('is-active', p.timer).stdout.trim()).toBe('active');
      let back = false;
      for (let i = 0; i < 60 && !back; i++) {
        back = await answers(p.port);
        if (!back) await sleep(500);
      }
      expect(back).toBe(true);
    },
    RUN,
  );

  it(
    'the backup runs from its unit in the sandbox, its timer is active, and a failed backup shows in its last result',
    async () => {
      const p = project();
      await switchService(place, p.spec(p.release(true)), env);
      expect(systemctl('is-active', p.timer).stdout.trim()).toBe('active');
      expect(lastBackup(env, p.repo)).toBe('no backup has run yet');

      expect(systemctl('start', p.backup).status).toBe(0);

      expect(readFileSync(join(p.app.backups, 'made'), 'utf8')).toBe('ENOENT');
      expect(lastBackup(env, p.repo)).toMatch(/^the last backup succeeded at \S/);
      expect(processes(p.backup)).toEqual([]);

      writeFileSync(join(p.app.data, 'fail'), '');
      expect(systemctl('start', p.backup).status).not.toBe(0);

      expect(lastBackup(env, p.repo)).toMatch(/^the last backup FAILED \(exit-code\) at \S/);
    },
    RUN,
  );

  it(
    'an answer from something else on the port does not pass: the service, whose pasta cannot bind it, does not stay running',
    async () => {
      const p = project();
      const stranger = createServer((_, res) => res.end('not the app'));
      await new Promise<void>((ok) => stranger.listen(p.port, '127.0.0.1', ok));
      onTestFinished(() => {
        stranger.close();
      });

      await expect(switchService(place, p.spec(p.release(true)), env)).rejects.toThrow(
        /did not stay running with one main process for 10 s .*; stopped and disabled the service, which had no earlier unit, and removed its unit, and removed the backup's units/,
      );

      expect(p.units()).toEqual([undefined, undefined, undefined]);
      expect(systemctl('is-active', p.unit).stdout.trim()).not.toBe('active');
    },
    RUN,
  );
});
