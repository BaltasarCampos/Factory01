import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerKeyPath } from '../../src/approvals/sign.js';
import { runCli } from '../../src/cli/commands.js';
import { CONSENT } from '../../src/commands/new.js';
import { verifyFirstParent } from '../../src/git/history.js';
import { gitEnv, makeRepo, runGit, signedReleaseTag, type TestRepo } from '../helpers/git-repo.js';
import { makeKeys, makeOtherKeys, tempDir, writeKeyFiles, type TestKeys } from '../helpers/keys.js';

vi.setConfig({ testTimeout: 60_000 });

const REPO = 'owner/project';

let owner: TestKeys;
let other: TestKeys;
beforeAll(() => {
  owner = makeKeys();
  other = makeOtherKeys();
});

const signersOf = (keys: TestKeys[]) => keys.map((k) => `${k.allowedSignersLine}\n`).join('');

interface Setup {
  /** Keys the pinned release lists; default the Owner's, the key config set signs with. */
  release?: TestKeys[];
  /** The key main's root commit is signed with. */
  mainKey?: TestKeys;
  /** The laptop's own key lists. */
  laptop?: TestKeys[];
}

function setup(options: Setup = {}) {
  const factory = makeRepo({
    files: { allowed_signers: signersOf(options.release ?? [owner]), revoked_keys: '' },
  });
  signedReleaseTag(factory, owner);
  const config = [
    `factory_release: v1.0.0@${factory.revParse('HEAD')}`,
    `repo: ${REPO}`,
    'inbox_issue: 1',
    'agents: local',
    'retry_limit: 3',
    '',
  ].join('\n');
  const project = makeRepo({
    files: { '.factory/config': config, 'README.md': 'hello\n' },
    signWith: options.mainKey ?? owner,
  });
  const home = tempDir('factory-home-');
  mkdirSync(join(home, '.factory', 'keys'), { recursive: true });
  writeFileSync(join(home, '.factory', 'allowed_signers'), signersOf(options.laptop ?? [owner]));
  writeFileSync(join(home, '.factory', 'revoked_keys'), '');
  copyFileSync(owner.privateKey, ownerKeyPath(home));
  chmodSync(ownerKeyPath(home), 0o600);
  copyFileSync(owner.publicKeyPath, `${ownerKeyPath(home)}.pub`);

  const asked: string[] = [];
  const cli = async (
    argv: string[],
    over: { env?: NodeJS.ProcessEnv; tty?: boolean; answer?: () => string } = {},
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    const env: NodeJS.ProcessEnv = {
      ...{ ...gitEnv, ...process.env },
      ...{ HOME: home, FACTORY_SOURCE: factory.path },
      ...over.env,
    };
    if (over.env?.CLAUDE_CODE_REMOTE === undefined) delete env.CLAUDE_CODE_REMOTE;
    const code = await runCli(['config', ...argv], {
      stdout: { write: (s: string) => void out.push(s) },
      stderr: { write: (s: string) => void err.push(s) },
      ...{ env, stdinIsTTY: over.tty ?? true, cwd: project.path },
      unreadAlerts: () => Promise.resolve([]),
      ask: (question) => {
        asked.push(out.join('') + question);
        return Promise.resolve(over.answer?.() ?? '');
      },
    });
    return { code, stdout: out.join(''), stderr: err.join('') };
  };
  const mainConfig = () => runGit(project.origin, ['show', 'main:.factory/config']);
  const mainHead = () => runGit(project.origin, ['rev-parse', 'main']);
  return { project, factory, cli, asked, mainConfig, mainHead };
}

/** Owner-signed main, checked with the pinned release's key lists. */
const signedMain = (project: TestRepo) => {
  project.git(['fetch', '-q', 'origin', 'main']);
  return verifyFirstParent(project.path, undefined, () => writeKeyFiles([owner]), { env: gitEnv });
};

describe('factory config set (T137, FR-007f, AC-090)', () => {
  it('changes one field as an Owner-signed commit on main that verifyFirstParent accepts', async () => {
    const t = setup();
    const before = t.mainHead();
    const config = t.mainConfig();

    const r = await t.cli(['set', 'retry_limit', '5']);

    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toContain('- retry_limit: 3\n+ retry_limit: 5\n');
    expect(r.stdout).toContain('run git pull --ff-only to update your checkout');
    expect(t.mainConfig()).toBe(config.replace('retry_limit: 3', 'retry_limit: 5'));
    const head = t.mainHead();
    expect(runGit(t.project.origin, ['rev-parse', 'main^1'])).toBe(before);
    expect(runGit(t.project.origin, ['diff', '--name-only', 'main^1', 'main'])).toBe(
      '.factory/config',
    );
    expect(signedMain(t.project)).toEqual({ ok: true, head });
  });

  it('adds a field main does not set yet', async () => {
    const t = setup();

    expect((await t.cli(['set', 'parallel_sessions', '2'])).code).toBe(0);

    expect(t.mainConfig()).toMatch(/\nparallel_sessions: 2$/);
  });

  it.each([
    ['factory_release', `v1.0.1@${'b'.repeat(40)}`, /factory_release is set by factory upgrade/],
    ['baseline', 'c'.repeat(40), /baseline is set by factory new\/adopt/],
    ['repo', 'owner/other', /repo is set by factory new\/adopt/],
    ['inbox_issue', '9', /inbox_issue is set by factory new\/adopt/],
    ['profile', 'typescript', /profile is set by factory new\/adopt/],
    ['colour', 'blue', /colour is not a \.factory\/config key/],
  ])('refuses %s, naming who sets it, and changes nothing', async (key, value, why) => {
    const t = setup();
    const before = t.mainHead();

    const r = await t.cli(['set', key, value]);

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(why);
    expect(t.mainHead()).toBe(before);
  });

  it.each([
    ['size_limit_lines', '500', /size_limit_lines: may only be lowered/],
    ['coverage_min', '80', /coverage_min: may only be raised/],
    ['parallel_sessions', '0', /parallel_sessions: must be a positive integer/],
    ['agents', 'anywhere', /agents: must be cloud or local/],
    ['retry_limit', '3\nbaseline: x', /not a plain value/],
    ['retry_limit', '1e3', /retry_limit: must be a positive integer/],
    ['coverage_min', '0x10', /coverage_min: must be a positive integer/],
  ])('keeps the config rules: refuses %s %j', async (key, value, why) => {
    const t = setup();
    const before = t.mainHead();

    const r = await t.cli(['set', key, value]);

    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(why);
    expect(t.mainHead()).toBe(before);
  });

  it('agents: cloud asks the cloud-consent question first, and changes nothing unless the Owner chooses cloud', async () => {
    const t = setup();
    const before = t.mainHead();

    const refused = await t.cli(['set', 'agents', 'cloud'], { answer: () => 'local' });

    expect(refused.code).toBe(1);
    expect(t.asked[0]).toContain(CONSENT);
    expect(t.mainHead()).toBe(before);

    expect((await t.cli(['set', 'agents', 'cloud'], { answer: () => 'cloud' })).code).toBe(0);
    expect(t.mainConfig()).toContain('agents: cloud');
  });

  it("commits only .factory/config, whatever is staged or edited in the Owner's working copy", async () => {
    const t = setup();
    writeFileSync(join(t.project.path, 'staged.txt'), 'staged\n');
    t.project.git(['add', 'staged.txt']);
    writeFileSync(join(t.project.path, 'README.md'), 'edited\n');
    const status = t.project.git(['status', '--porcelain']);
    const head = t.project.revParse('HEAD');

    expect((await t.cli(['set', 'retry_limit', '4'])).code).toBe(0);

    expect(runGit(t.project.origin, ['diff', '--name-only', 'main^1', 'main'])).toBe(
      '.factory/config',
    );
    expect(t.project.git(['status', '--porcelain'])).toBe(status);
    expect(t.project.revParse('HEAD')).toBe(head);
  });

  it('a push rejected because main moved aborts with nothing changed', async () => {
    const t = setup();
    const other = makeRepo();
    other.git(['fetch', '-q', t.project.origin, 'main']);
    // While the Owner answers, another signed commit lands on main.
    const moved = () => {
      other.git(['checkout', '-q', '-b', 'main', 'FETCH_HEAD']);
      other.commit({ 'x.md': 'x\n' }, 'meanwhile', { signWith: owner });
      other.git(['push', '-q', t.project.origin, 'main:main']);
      return 'cloud';
    };

    const r = await t.cli(['set', 'agents', 'cloud'], { answer: moved });

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/main moved .*nothing changed/);
    expect(t.mainHead()).toBe(other.revParse('main'));
    expect(t.mainConfig()).toContain('agents: local');
  });

  it('refuses before pushing when the release pinned on main does not accept the signing key', async () => {
    const t = setup({ release: [other], mainKey: other, laptop: [other, owner] });
    const before = t.mainHead();

    const r = await t.cli(['set', 'retry_limit', '5']);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      'your signing key is not accepted by the release pinned on main; nothing was pushed',
    );
    expect(t.mainHead()).toBe(before);
  });

  it('a push refused while main did not move says so, with git’s own reason', async () => {
    const t = setup();
    const hook = join(t.project.origin, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "main is a protected branch" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const before = t.mainHead();

    const r = await t.cli(['set', 'retry_limit', '5']);

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/the push was refused: .*main is a protected branch/s);
    expect(r.stderr).not.toMatch(/main moved/);
    expect(t.mainHead()).toBe(before);
  });

  it('refuses while main has a first-parent commit the Owner did not sign', async () => {
    const t = setup();
    t.project.commit({ 'x.md': 'merge button\n' }, 'unsigned');
    t.project.push('main');

    const r = await t.cli(['set', 'retry_limit', '5']);

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not signed by the Owner/);
    expect(t.mainConfig()).toContain('retry_limit: 3');
  });

  it.each([
    ['in a cloud session', { env: { CLAUDE_CODE_REMOTE: 'true' } }],
    ['without a terminal', { tty: false }],
  ] as const)('refuses %s (AC-090)', async (_name, over) => {
    const t = setup();
    const before = t.mainHead();

    const r = await t.cli(['set', 'retry_limit', '5'], over);

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/runs only on the Owner's laptop/);
    expect(t.mainHead()).toBe(before);
  });

  it('takes only `set`', async () => {
    const t = setup();
    expect((await t.cli(['get', 'retry_limit', '5'])).code).toBe(2);
  });
});
