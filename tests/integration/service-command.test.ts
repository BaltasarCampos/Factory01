// `factory service app` (T069, slice 23b-2a): what the app's unit runs. It checks every argument
// again, though only factory code wrote them, runs the app in the deploy sandbox until it exits,
// and exits non-zero when the app does, so the unit's Restart=on-failure starts it again.
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/commands.js';
import { appFolder } from '../../src/deploy/sandbox.js';
import { tempDir } from '../helpers/keys.js';

const RELEASE = `${'a'.repeat(40)}-20261013T153000Z`;

function project(start = 'node -e "process.exit(3)"') {
  const home = realpathSync(tempDir());
  const app = appFolder(home, 'owner/project');
  const release = join(app.releases, RELEASE);
  for (const dir of [release, app.data, app.backups]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(app.settings, '..'), { recursive: true });
  writeFileSync(app.settings, 'TOKEN=settings\n', { mode: 0o600 });
  writeFileSync(
    join(release, 'package.json'),
    JSON.stringify({ name: 'p', version: '1.0.0', scripts: { start } }),
  );
  return { home, app, release };
}

async function service(home: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const err: string[] = [];
  const code = await runCli(['service', ...args], {
    stdout: { write: () => true },
    stderr: { write: (s: string) => void err.push(s) },
    env: { PATH: process.env.PATH, HOME: home, ...env },
    // As under systemd: no terminal.
    stdinIsTTY: false,
    unreadAlerts: () => Promise.reject(new Error('service must not read the inbox')),
  });
  return { code, stderr: err.join('') };
}

describe('factory service app (T069)', () => {
  it('runs the release’s app in the sandbox and exits non-zero when the app does', async () => {
    const p = project();
    const r = await service(p.home, ['app', 'owner/project', RELEASE, '--port', '8080']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/the app of owner\/project exited with 3/);
  }, 120_000);

  it.each([
    [
      'a repository that is not owner/name',
      ['app', 'owner/../x', RELEASE, '--port', '8080'],
      /owner\/name/,
    ],
    [
      'a release that is not <sha>-<stamp>',
      ['app', 'owner/project', '..', '--port', '8080'],
      /not a release name/,
    ],
    [
      'a port outside 1024 to 65535',
      ['app', 'owner/project', RELEASE, '--port', '80'],
      /1024 to 65535/,
    ],
    [
      'a port that is not a number',
      ['app', 'owner/project', RELEASE, '--port', '8080x'],
      /1024 to 65535/,
    ],
    ['a run other than app', ['build', 'owner/project', RELEASE, '--port', '8080'], /app/],
  ])('refuses %s', async (_, args, said) => {
    const p = project();
    const r = await service(p.home, args);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(said);
  });

  it('refuses a release folder that is a link, or missing, and runs nothing', async () => {
    const p = project();
    const linked = `${'b'.repeat(40)}-20261013T153000Z`;
    symlinkSync(p.release, join(p.app.releases, linked));

    const viaLink = await service(p.home, ['app', 'owner/project', linked, '--port', '8080']);
    const missing = await service(p.home, [
      'app',
      'owner/project',
      `${'c'.repeat(40)}-20261013T153000Z`,
      '--port',
      '8080',
    ]);

    expect(viaLink.stderr).toMatch(/is not a release folder/);
    expect(missing.stderr).toMatch(/is not a release folder/);
  });

  it('refuses in a cloud session', async () => {
    const p = project();
    const r = await service(p.home, ['app', 'owner/project', RELEASE, '--port', '8080'], {
      CLAUDE_CODE_REMOTE: '1',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cloud session/);
  });
});
