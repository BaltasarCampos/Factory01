// The app's systemd user unit and the backup's (T069, slices 23b-2a and 23b-2b; Owner decisions
// 2026-10-13 and 2026-10-14): fixed by factory code, naming their release explicitly and running
// factory code, never pasta or bwrap; nothing from the project or the release reaches them but
// the names the factory checked.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appUnit,
  backupTimer,
  backupUnit,
  switchService,
  unitName,
  unitRelease,
} from '../../src/deploy/service.js';
import { tempDir } from '../helpers/keys.js';

const RELEASE = `${'a'.repeat(40)}-20261013T153000Z`;
const SPEC = {
  repo: 'owner/project',
  release: RELEASE,
  port: 8080,
  home: '/home/owner',
  factory: '/home/owner/Projects/Factory01',
  program: ['/usr/bin/node', '/home/owner/Projects/Factory01/dist/cli/main.js'],
};

describe('the app’s unit (T069)', () => {
  it('is named after the repository, the owner and the name split by a double hyphen', () => {
    expect(unitName('owner/project')).toBe('factory-app-owner--project.service');
    expect(unitName('my-org/my--app.v2')).toBe('factory-app-my-org--my--app.v2.service');
    expect(unitName('owner/project', 'backup')).toBe('factory-backup-owner--project.service');
    expect(unitName('owner/project', 'backup', 'timer')).toBe(
      'factory-backup-owner--project.timer',
    );
  });

  it('is exactly this text: the release named, factory code started, PATH and HOME only', () => {
    expect(appUnit(SPEC))
      .toBe(`# Written by factory deploy (T069): do not edit; the next deploy rewrites it.
# Runs owner/project's app from release ${RELEASE} in the deploy sandbox, through the
# factory code in /home/owner/Projects/Factory01: whatever dist/ was last built there is what
# runs at the service's next restart.
[Unit]
Description=factory: the app of owner/project

[Service]
Type=simple
Environment=PATH=/usr/bin:/bin
Environment=HOME=/home/owner
ExecStart=/usr/bin/node /home/owner/Projects/Factory01/dist/cli/main.js service app owner/project ${RELEASE} --port 8080
Restart=on-failure
RestartSec=5
IgnoreSIGPIPE=no
KillMode=control-group

[Install]
WantedBy=default.target
`);
  });

  it('the backup’s service runs one backup of the same release, without a port; its timer runs it daily', () => {
    expect(backupUnit(SPEC))
      .toBe(`# Written by factory deploy (T069): do not edit; the next deploy rewrites it.
# Backs up owner/project's data with release ${RELEASE} in the deploy sandbox, through the
# factory code in /home/owner/Projects/Factory01: whatever dist/ was last built there is what
# runs at the next backup.
[Unit]
Description=factory: the daily backup of owner/project

[Service]
Type=oneshot
Environment=PATH=/usr/bin:/bin
Environment=HOME=/home/owner
ExecStart=/usr/bin/node /home/owner/Projects/Factory01/dist/cli/main.js service backup owner/project ${RELEASE}
TimeoutStartSec=1h
IgnoreSIGPIPE=no
KillMode=control-group
`);
    expect(backupTimer(SPEC))
      .toBe(`# Written by factory deploy (T069): do not edit; the next deploy rewrites it.
[Unit]
Description=factory: the daily backup of owner/project

[Timer]
OnCalendar=daily
Persistent=true
Unit=factory-backup-owner--project.service

[Install]
WantedBy=timers.target
`);
  });

  it('names its release, which reading the unit back finds; nothing else passes for one', () => {
    expect(unitRelease(appUnit(SPEC), 'owner/project')).toBe(RELEASE);
    expect(unitRelease(backupUnit(SPEC), 'owner/project', 'backup')).toBe(RELEASE);
    expect(unitRelease(backupUnit(SPEC), 'owner/project')).toBeUndefined();
    expect(unitRelease(appUnit(SPEC), 'owner/project', 'backup')).toBeUndefined();
    expect(unitRelease(appUnit(SPEC), 'owner/other')).toBeUndefined();
    expect(unitRelease('ExecStart=/bin/sh -c evil\n', 'owner/project')).toBeUndefined();
    const twice = `${appUnit(SPEC)}ExecStart=x service app owner/project ${'b'.repeat(40)}-20261014T000000Z --port 1\n`;
    expect(unitRelease(twice, 'owner/project')).toBeUndefined();
  });

  it.each([
    ['a home with a space', { home: '/home/the owner' }],
    ['a Node path with a systemd specifier', { program: ['/opt/node%h/node', '/f/main.js'] }],
    ['a program path with a quote', { program: ['/usr/bin/node', '/f/"main".js'] }],
    ['a release that is not <sha>-<stamp>', { release: '../outside' }],
    ['a repository that is not owner/name', { repo: 'owner/../x' }],
    ['a port outside 1024 to 65535', { port: 80 }],
  ])('refuses %s', (_, change) => {
    expect(() => appUnit({ ...SPEC, ...change })).toThrow(
      /refusing to write the unit|1024 to 65535/,
    );
    if (!('port' in change))
      for (const unit of [backupUnit, backupTimer])
        expect(() => unit({ ...SPEC, ...change })).toThrow(/refusing to write the unit/);
  });
});

describe('the start check’s steady window (T069)', () => {
  it.each([0, 500, 999])(
    'refuses %i ms before writing any unit: steady() reads once a second, so it would read once',
    async (steadyMs) => {
      const dir = join(tempDir(), 'units');

      await expect(switchService({ dir, runtime: true }, SPEC, {}, { steadyMs })).rejects.toThrow(
        `the steady check needs at least 1 s, not ${String(steadyMs)} ms`,
      );
      expect(existsSync(dir)).toBe(false);
    },
  );
});
