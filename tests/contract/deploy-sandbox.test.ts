// Contract tests for the deploy sandbox (T069, slice 23a; design v1.8, Owner decisions
// 2026-10-13), run for real as the test sandbox's are: in the factory's own CI, which installs
// bubblewrap; never skipped when it is missing. From inside each run, what it can write and read
// must be exactly its row of the table, and nothing a run leaves behind outlives it. What each run
// can reach is network.test.ts's.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { appFolder, deployRunner, type DeployRun } from '../../src/deploy/sandbox.js';
import { tempDir } from '../helpers/keys.js';

const RUN = 60_000;
/** The app's port, which only the app run forwards. */
const PORT = 20_000 + (process.pid % 10_000);

/** The app folder with a release, data, backups and a settings file, under a temp home. */
function layout() {
  const app = appFolder(tempDir(), 'owner/project');
  const release = join(app.releases, `${'a'.repeat(40)}-20261013T153000Z`);
  for (const dir of [release, app.data, app.backups]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(app.settings, '..'), { recursive: true });
  writeFileSync(app.settings, 'TOKEN=settings\n');
  return { app, release };
}

/** What a run can do, from inside it, as JSON on stdout. */
const PROBE = (secret: string) => `
const fs = require('node:fs');
const can = (f) => { try { f(); return true; } catch { return false; } };
const out = {
  code: can(() => fs.writeFileSync('/app/code/w', 'x')),
  data: can(() => fs.writeFileSync('/app/data/w', 'x')),
  backups: can(() => fs.writeFileSync('/app/backups/w', 'x')),
  settings: can(() => fs.readFileSync('/app/settings.env')),
  home: can(() => fs.readFileSync(${JSON.stringify(secret)})),
};
console.log(JSON.stringify(out));
`;

const EXPECTED: Record<DeployRun, Record<string, boolean>> = {
  install: { code: true, data: false, backups: false, settings: false, home: false },
  build: { code: true, data: false, backups: false, settings: false, home: false },
  app: { code: false, data: true, backups: false, settings: true, home: false },
  backup: { code: false, data: true, backups: true, settings: false, home: false },
};

describe('the deploy sandbox, from inside each run (T069)', () => {
  it.each(Object.keys(EXPECTED) as DeployRun[])(
    'the %s run writes and reads exactly what its row allows, and nothing under the real home',
    (run) => {
      const fixture = mkdtempSync(join(homedir(), '.factory-deploy-test-'));
      try {
        const secret = join(fixture, 'approve_ed25519');
        writeFileSync(secret, 'the Owner’s key\n');
        const { app, release } = layout();

        const result = deployRunner(
          app,
          release,
          process.env,
          PORT,
        )(run, [process.execPath, '-e', PROBE(secret)]);

        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual(EXPECTED[run]);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
    RUN,
  );

  it(
    'a process a build leaves behind dies with it, so nothing writes into the release afterwards',
    async () => {
      const { app, release } = layout();
      const late = "setsid sh -c 'sleep 1; echo late > /app/code/late.txt' >/dev/null 2>&1 &";

      const result = deployRunner(
        app,
        release,
        process.env,
      )('build', ['/bin/sh', '-c', `${late} exit 0`]);
      await sleep(2500);

      expect(result.status).toBe(0);
      expect(existsSync(join(release, 'late.txt'))).toBe(false);
    },
    RUN,
  );
});

describe('the deploy sandbox fails closed (T069)', () => {
  it('without bwrap, or when user namespaces fail, refuses and never runs unsandboxed', () => {
    const { app, release } = layout();
    expect(() => deployRunner(app, release, { PATH: tempDir() })).toThrow(
      /only inside bubblewrap.*sudo apt install bubblewrap/,
    );
    const bin = tempDir();
    writeFileSync(
      join(bin, 'bwrap'),
      '#!/bin/sh\necho "bwrap: setting up uid map: Permission denied" >&2\nexit 1\n',
    );
    chmodSync(join(bin, 'bwrap'), 0o755);
    expect(() => deployRunner(app, release, { PATH: `${bin}:/usr/bin:/bin` })).toThrow(
      /user namespaces.*setting up uid map: Permission denied/,
    );
  });
});
