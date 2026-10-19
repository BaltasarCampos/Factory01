// Contract tests for the SCA and licence checks (T169, FR-049, Owner decisions 2026-10-18):
// `factory ci scan audit` fails only on advisories the pull request introduces, at high and
// critical, with the pinned npm isolated from every .npmrc; `factory ci licences` reads each new or
// changed package's licence from the registry, never from the lockfile, against the allowlist.
// Neither goes online here: the audit runs the stand-in npm in tests/helpers/npm, and the
// licences read a registry served by the test.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { licenceAllowed } from '../../src/ci/licences.js';
import { readLockfile } from '../../src/ci/lockfile.js';
import { runCli } from '../../src/cli/commands.js';
import { gitEnv, makeRepo, type TestRepo } from '../helpers/git-repo.js';

const NPM = fileURLToPath(new URL('../helpers/npm', import.meta.url));

interface Pkg {
  version: string;
  /** Default: the registry tarball of the entry's name and version; null leaves it out. */
  resolved?: string | null;
  name?: string;
  inBundle?: boolean;
  /** What the lockfile claims; the check must never read it. */
  license?: string;
  fakeAdvisories?: { source: number; severity: string; title: string }[];
}

/** The registry tarball npm resolves `name@version` to. */
const tgz = (name: string, version: string) =>
  `https://registry.npmjs.org/${name}/-/${name.slice(name.indexOf('/') + 1)}-${version}.tgz`;

/** A lockfile v3 listing `packages` under node_modules/. */
function lockfile(packages: Record<string, Pkg>, root: Record<string, unknown> = {}): string {
  const entries = Object.fromEntries(
    Object.entries(packages).map(([key, { resolved, ...p }]) => {
      const name = p.name ?? key;
      const tarball = tgz(name, p.version);
      const at = resolved === null ? {} : { resolved: resolved ?? tarball };
      return [`node_modules/${key}`, { ...p, ...at }];
    }),
  );
  return `${JSON.stringify(
    {
      ...{ name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true },
      packages: { '': { name: 'app', version: '1.0.0', ...root }, ...entries },
    },
    null,
    2,
  )}\n`;
}

/** main with `base` locked; the item branch checked out with `head` committed. */
function project(base: string | null, head: string | null, extra: Record<string, string> = {}) {
  const files: Record<string, string> = { 'package.json': '{ "name": "app" }\n' };
  if (base !== null) files['package-lock.json'] = base;
  const repo = makeRepo({ files });
  const start = repo.revParse('HEAD');
  repo.checkout('claude/42-deps', { create: true });
  repo.commit({ 'package-lock.json': head, ...extra }, 'dependencies');
  return { repo, start };
}

async function ci(
  repo: TestRepo,
  args: string[],
  over: { env?: NodeJS.ProcessEnv; registry?: string } = {},
) {
  const out: string[] = [];
  const code = await runCli(['ci', ...args], {
    stdout: { write: (s: string) => void out.push(s) },
    stderr: { write: (s: string) => void out.push(s) },
    env: { ...gitEnv, PATH: `${NPM}${delimiter}${process.env.PATH ?? ''}`, ...over.env },
    stdinIsTTY: false,
    cwd: repo.path,
    unreadAlerts: () => Promise.reject(new Error('ci must not read the inbox')),
    ...(over.registry === undefined ? {} : { npmRegistry: over.registry }),
  });
  return { code, output: out.join('') };
}

const HIGH = { source: 1001, severity: 'high', title: 'Prototype pollution' };

describe('factory ci scan audit (T169)', () => {
  const audit = (repo: TestRepo, start: string, env: NodeJS.ProcessEnv = {}) =>
    ci(repo, ['scan', 'audit', start, 'HEAD'], { env });

  it('fails on a high or critical advisory new at the head, naming it; a moderate one passes', async () => {
    const base = lockfile({ left: { version: '1.0.0' } });
    const head = lockfile({
      left: { version: '1.0.0', fakeAdvisories: [{ ...HIGH, severity: 'moderate' }] },
      right: { version: '2.0.0', fakeAdvisories: [HIGH] },
      bad: {
        version: '0.1.0',
        fakeAdvisories: [{ source: 1002, severity: 'critical', title: 'RCE' }],
      },
    });
    const { repo, start } = project(base, head);

    const r = await audit(repo, start);

    expect(r.code).toBe(1);
    expect(r.output).toContain('scan audit: 3 advisories at the head, 0 at the merge base');
    expect(r.output).toContain(
      'right: high advisory https://github.com/advisories/GHSA-fake-1001, new at the head: Prototype pollution',
    );
    expect(r.output).toContain(
      'bad: critical advisory https://github.com/advisories/GHSA-fake-1002',
    );
    expect(r.output).not.toContain('left:');
  });

  it('an advisory already at the merge base is not new, even when the package moves to another covered version', async () => {
    const base = lockfile({ right: { version: '2.0.0', fakeAdvisories: [HIGH] } });
    const head = lockfile({ right: { version: '2.0.1', fakeAdvisories: [HIGH] } });
    const { repo, start } = project(base, head);

    const r = await audit(repo, start);

    expect(r).toMatchObject({ code: 0 });
    expect(r.output).toContain('scan audit: pass');
  });

  it('the same advisory ID on another package is new', async () => {
    const base = lockfile({ right: { version: '2.0.0', fakeAdvisories: [HIGH] } });
    const head = lockfile({
      right: { version: '2.0.0', fakeAdvisories: [HIGH] },
      other: { version: '1.0.0', fakeAdvisories: [HIGH] },
    });
    const { repo, start } = project(base, head);

    const r = await audit(repo, start);

    expect(r.code).toBe(1);
    expect(r.output).toContain('other: high advisory');
    expect(r.output).not.toContain('right: high advisory');
  });

  it('a .npmrc in the pull request and npm config on the runner change nothing', async () => {
    const head = lockfile({ right: { version: '2.0.0', fakeAdvisories: [HIGH] } });
    const npmrc = 'registry=https://evil.invalid/\naudit-level=critical\n';
    const { repo, start } = project(lockfile({}), head, { '.npmrc': npmrc });
    const env = {
      npm_config_audit_level: 'critical',
      NPM_CONFIG_REGISTRY: 'https://evil.invalid/',
    };

    const r = await audit(repo, start, env);

    expect(r.code).toBe(1);
    expect(r.output).toContain('right: high advisory');
  });

  it('an unchanged lockfile is not audited; an audit that cannot reach the registry fails', async () => {
    const offline = lockfile({ right: { version: '2.0.0' } }, { fakeOffline: true });
    const same = project(offline, offline, { 'src/x.ts': 'x\n' });
    const unchanged = await audit(same.repo, same.start);
    expect(unchanged).toMatchObject({ code: 0 });
    expect(unchanged.output).toContain('package-lock.json is unchanged since the merge base');

    const moved = project(
      offline,
      lockfile({ right: { version: '2.0.1' } }, { fakeOffline: true }),
    );
    const r = await audit(moved.repo, moved.start);
    expect(r.code).toBe(1);
    expect(r.output).toContain('npm audit reported no audit');
    expect(r.output).toContain('request to https://registry.npmjs.org failed');
  });

  it('a head without package-lock.json fails; an npm other than the pinned one is refused', async () => {
    const { repo, start } = project(lockfile({}), null);
    const r = await audit(repo, start);
    expect(r.code).toBe(1);
    expect(r.output).toContain('no package-lock.json at the head');

    const other = project(lockfile({}), lockfile({ right: { version: '2.0.0' } }));
    const v = await audit(other.repo, other.start, { FAKE_NPM_VERSION: '11.10.0' });
    expect(v.code).toBe(1);
    expect(v.output).toMatch(/npm 11\.10\.0; the release pins 11\.11\.0/);
  });
});

describe('factory ci licences (T169)', () => {
  /** The registry's licence per `name@version`; a missing key answers 404. */
  let licences: Record<string, unknown> = {};
  const asked: string[] = [];
  let server: Server;
  let registry: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = decodeURIComponent(req.url ?? '');
      asked.push(path);
      const [, name = '', version = ''] = /^\/(.+)\/([^/]+)$/.exec(path) ?? [];
      const key = `${name}@${version}`;
      if (!(key in licences)) {
        res.writeHead(404).end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      const found = licences[key];
      // A `{ licenses: [...] }` value stands for the registry's legacy array field.
      const legacy = typeof found === 'object' && found !== null && 'licenses' in found;
      res.end(JSON.stringify({ name, version, ...(legacy ? found : { license: found }) }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    registry = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );

  const check = async (base: string | null, head: string) => {
    asked.length = 0;
    const { repo, start } = project(base, head);
    return ci(repo, ['licences', start, 'HEAD'], { registry });
  };

  it('looks up only the packages new or changed since the merge base, and passes allowed licences', async () => {
    licences = { 'kept@1.0.0': 'GPL-3.0', 'new@1.0.0': 'MIT', '@scope/pkg@2.0.0': 'Apache-2.0' };
    licences['moved@1.1.0'] = 'CC-BY-4.0';
    const base = lockfile({ kept: { version: '1.0.0' }, moved: { version: '1.0.0' } });
    const head = lockfile({
      kept: { version: '1.0.0' },
      moved: { version: '1.1.0' },
      new: { version: '1.0.0' },
      '@scope/pkg': { version: '2.0.0' },
    });

    const r = await check(base, head);

    expect(r).toMatchObject({ code: 0 });
    expect(r.output).toContain('licences: 3 packages new or changed since the merge base');
    expect([...asked].sort()).toEqual(['/@scope/pkg/2.0.0', '/moved/1.1.0', '/new/1.0.0']);
  });

  it('reads the licence from the registry, never from the lockfile', async () => {
    licences = { 'copyleft@1.0.0': 'GPL-3.0-only' };
    const head = lockfile({ copyleft: { version: '1.0.0', license: 'MIT' } });

    const r = await check(lockfile({}), head);

    expect(r.code).toBe(1);
    expect(r.output).toContain(
      "copyleft@1.0.0: licence GPL-3.0-only is not on the release's allowlist",
    );
  });

  it('fails a missing licence, an unknown package and a registry that cannot be reached', async () => {
    licences = { 'bare@1.0.0': undefined };
    const head = lockfile({ bare: { version: '1.0.0' }, ghost: { version: '9.9.9' } });

    const r = await check(null, head);
    expect(r.code).toBe(1);
    expect(r.output).toContain('bare@1.0.0: no licence on the registry');
    expect(r.output).toContain('ghost@9.9.9: the registry answered 404');

    const { repo, start } = project(null, lockfile({ bare: { version: '1.0.0' } }));
    const down = await ci(repo, ['licences', start, 'HEAD'], { registry: 'http://127.0.0.1:9' });
    expect(down.code).toBe(1);
    expect(down.output).toContain('bare@1.0.0: the registry lookup failed');
  });

  it.each<[string, unknown, boolean]>([
    ['an allowed id', 'ISC', true],
    ['an OR with one allowed side', '(MIT OR GPL-3.0)', true],
    ['an AND with one disallowed side', 'MIT AND GPL-3.0', false],
    ['nested parentheses', '(MIT AND (Apache-2.0 OR GPL-2.0))', true],
    ['an exception not listed whole', 'Apache-2.0 WITH LLVM-exception', false],
    ['UNLICENSED', 'UNLICENSED', false],
    ['SEE LICENSE IN', 'SEE LICENSE IN LICENSE.md', false],
    ['an unbalanced expression', '(MIT OR ISC', false],
    ['a legacy { type } object', { type: 'BSD-3-Clause' }, true],
    [
      'a legacy licenses array, read as an OR',
      { licenses: [{ type: 'GPL-3.0' }, { type: 'MIT' }] },
      true,
    ],
    ['a legacy licenses array with no allowed type', { licenses: [{ type: 'GPL-3.0' }] }, false],
  ])('%s: allowed is %s', async (_name, licence, ok) => {
    licences = { 'pkg@1.0.0': licence };
    const r = await check(lockfile({}), lockfile({ pkg: { version: '1.0.0' } }));
    expect(r.code).toBe(ok ? 0 : 1);
  });

  it('licenceAllowed lists the exception form whole', () => {
    const list = new Set(['MIT', 'Apache-2.0 WITH LLVM-exception']);
    expect(licenceAllowed('Apache-2.0 WITH LLVM-exception', list)).toBe(true);
    expect(licenceAllowed('Apache-2.0', list)).toBe(false);
    expect(licenceAllowed('MIT OR', list)).toBe(false);
    expect(licenceAllowed('', list)).toBe(false);
  });
});

describe('the lockfile identity rule, before both checks (T169, 24b-5)', () => {
  const MIT = { version: '1.0.0' };
  it.each<[string, Record<string, Pkg>, string]>([
    [
      'an alias without its name field',
      { 'nice-mit': { ...MIT, resolved: tgz('evil', '1.0.0') } },
      'node_modules/nice-mit: resolves to "https://registry.npmjs.org/evil/-/evil-1.0.0.tgz", not https://registry.npmjs.org/nice-mit/-/nice-mit-1.0.0.tgz',
    ],
    [
      'a registry tarball of another package',
      { left: { ...MIT, resolved: tgz('right', '1.0.0') } },
      'node_modules/left: resolves to "https://registry.npmjs.org/right/-/right-1.0.0.tgz"',
    ],
    [
      'another host',
      { left: { ...MIT, resolved: 'https://registry.evil.invalid/left/-/left-1.0.0.tgz' } },
      'node_modules/left: resolves to "https://registry.evil.invalid/left/-/left-1.0.0.tgz"',
    ],
    [
      'a git dependency',
      { left: { ...MIT, resolved: 'git+ssh://git@github.com/someone/left.git#0123456789abcdef' } },
      'node_modules/left: resolves to "git+ssh://git@github.com/someone/left.git#0123456789abcdef"',
    ],
    [
      'no resolved outside a bundle',
      { left: { ...MIT, resolved: null } },
      'node_modules/left: resolves to nothing',
    ],
    [
      'a name npm refuses',
      { 'Bad Name': MIT },
      'node_modules/Bad Name: "Bad Name" is not a valid npm package name',
    ],
    [
      'a version that is not semver',
      { left: { version: '1.0' } },
      'node_modules/left: version "1.0" is not semver',
    ],
  ])('%s fails both jobs, naming the entry', async (_name, packages, finding) => {
    const { repo, start } = project(lockfile({}), lockfile(packages));
    const audit = await ci(repo, ['scan', 'audit', start, 'HEAD']);
    const licences = await ci(repo, ['licences', start, 'HEAD'], {
      registry: 'http://127.0.0.1:9',
    });

    for (const r of [audit, licences]) {
      expect(r.code).toBe(1);
      expect(r.output).toContain(`package-lock.json: ${finding}`);
    }
  });

  it('a bundled dependency may have no resolved; this repository’s own lockfile passes', () => {
    const { repo } = project(
      lockfile({}),
      lockfile({ inner: { version: '2.0.0', resolved: null, inBundle: true } }),
    );
    expect(readLockfile(repo.path, 'HEAD', gitEnv).problems).toEqual([]);
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const own = readLockfile(root, 'HEAD', gitEnv);
    expect(own.problems).toEqual([]);
    expect(own.packages.some((p) => p.name.startsWith('@'))).toBe(true);
  });
});
