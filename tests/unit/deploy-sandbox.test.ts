// Which deploy run sees what (T069, slice 23a; Owner decisions 2026-10-13): one fixed table in
// factory code, a test per row. Every run gets the system folders and the Node install read-only,
// even under the home folder, and nothing else; the bubblewrap arguments come only from here.
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { npmCli } from '../../src/ci/sandbox.js';
import { appFolder, deployArgs, RUNS, type DeployRun } from '../../src/deploy/sandbox.js';

const HOME = '/home/owner';
const app = appFolder(HOME, 'owner/project');
const RELEASE = `${app.releases}/${'a'.repeat(40)}-20261013T153000Z`;
const node = dirname(realpathSync(process.execPath));
const npm = dirname(dirname(npmCli()));

/** Each bind as [flag, source, destination]. */
function binds(args: readonly string[]): [string, string, string][] {
  return args.flatMap((a, i) =>
    /^--(?:ro-|dev-)?bind(?:-try)?$/.test(a)
      ? [[a, args[i + 1] ?? '', args[i + 2] ?? ''] as [string, string, string]]
      : [],
  );
}
/** The environment the run starts with: `--setenv` pairs after `--clearenv`. */
function environment(args: readonly string[]): Record<string, string> {
  expect(args).toContain('--clearenv');
  return Object.fromEntries(
    args.flatMap((a, i) => (a === '--setenv' ? [[args[i + 1] ?? '', args[i + 2] ?? '']] : [])),
  );
}
const at = (args: readonly string[], inside: string) =>
  binds(args).find(([, , to]) => to === inside)?.[0];

const ROWS: [DeployRun, Record<string, string | undefined>, boolean, Record<string, string>][] = [
  [
    'install',
    {
      '/app/code': '--bind',
      '/app/data': undefined,
      '/app/backups': undefined,
      '/app/settings.env': undefined,
    },
    true,
    { HOME: '/app/code/.home' },
  ],
  [
    'build',
    {
      '/app/code': '--bind',
      '/app/data': undefined,
      '/app/backups': undefined,
      '/app/settings.env': undefined,
    },
    false,
    { HOME: '/app/code/.home' },
  ],
  [
    'app',
    {
      '/app/code': '--ro-bind',
      '/app/data': '--bind',
      '/app/backups': undefined,
      '/app/settings.env': '--ro-bind',
    },
    true,
    { HOME: '/app/data', APP_SETTINGS: '/app/settings.env' },
  ],
  [
    'backup',
    {
      '/app/code': '--ro-bind',
      '/app/data': '--bind',
      '/app/backups': '--bind',
      '/app/settings.env': undefined,
    },
    false,
    { HOME: '/app/data' },
  ],
];

describe('the deploy sandbox table (T069)', () => {
  it('has exactly the four runs', () => {
    expect(Object.keys(RUNS).sort()).toEqual(['app', 'backup', 'build', 'install']);
  });

  it.each(ROWS)('the %s run sees exactly its row', (run, folders, network, env) => {
    const args = deployArgs(run, app, RELEASE);

    for (const [inside, flag] of Object.entries(folders)) expect(at(args, inside)).toBe(flag);
    expect(args.includes('--share-net')).toBe(network);
    expect(environment(args)).toEqual({ PATH: `${node}:/usr/bin:/bin`, ...env });
    expect(args).toEqual(
      expect.arrayContaining([
        ...['--unshare-all', '--unshare-pid', '--die-with-parent', '--new-session'],
      ]),
    );
    expect(args.slice(args.indexOf('--chdir'), args.indexOf('--chdir') + 2)).toEqual([
      '--chdir',
      '/app/code',
    ]);
    // Writable: only the app folder's own parts, each at its fixed place inside.
    const writable = binds(args).filter(([flag]) => flag === '--bind');
    const sources: Record<string, string> = {
      '/app/code': RELEASE,
      '/app/data': app.data,
      '/app/backups': app.backups,
    };
    for (const [, from, to] of writable) expect(from).toBe(sources[to]);
    // From the home folder: the Node install, the release, the app's folders and its settings.
    const fromHome = binds(args)
      .map(([, from]) => from)
      .filter(
        (from) => from === HOME || from.startsWith(`${HOME}/`) || HOME.startsWith(`${from}/`),
      );
    for (const from of fromHome)
      expect([RELEASE, app.data, app.backups, app.settings]).toContain(from);
  });

  it.each(ROWS.map(([run]) => run))(
    'the %s run binds the system folders and the Node install read-only, a private /tmp, and nothing else',
    (run) => {
      const args = deployArgs(run, app, RELEASE);
      const readOnly = binds(args)
        .filter(([flag, , to]) => flag === '--ro-bind' && !to.startsWith('/app/'))
        .map(([, from, to]) => (expect(to).toBe(from), from));

      expect(readOnly).toEqual(expect.arrayContaining(['/usr', '/etc', node, npm]));
      for (const from of readOnly)
        expect(
          ['/usr', '/bin', '/etc', node, npm].includes(from) ||
            /^\/lib/.test(from) ||
            from.startsWith('/run/systemd/resolve'),
        ).toBe(true);
      expect(args.join(' ')).toContain('--tmpfs /tmp');
      expect(
        binds(args).filter(([, from]) => from === '/tmp' || from.startsWith('/run/user')),
      ).toEqual([]);
    },
  );

  it('the Node install is bound even when it lives under the home folder (nvm), and nothing else of it', () => {
    const home = dirname(dirname(node));
    const nvm = appFolder(home, 'owner/project');
    const release = `${nvm.releases}/${'a'.repeat(40)}-20261013T153000Z`;
    const args = deployArgs('build', nvm, release);
    const fromHome = binds(args)
      .map(([, from]) => from)
      .filter((from) => from === home || from.startsWith(`${home}/`));

    expect(binds(args)).toContainEqual(['--ro-bind', node, node]);
    for (const from of fromHome) expect([node, npm, release]).toContain(from);
  });
});
