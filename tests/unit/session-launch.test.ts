import { existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runLoop } from '../../src/commands/run.js';
import type { PassResult } from '../../src/dispatcher/dispatch.js';
import { CloudLauncher, cloudInvocation } from '../../src/dispatcher/launcher/cloud.js';
import {
  LocalLauncher,
  localInvocation,
  type Runner,
} from '../../src/dispatcher/launcher/local.js';
import { LaunchRefused } from '../../src/dispatcher/launcher/types.js';
import { resolveSession } from '../../src/hooks/log.js';
import { DEFINE_BRANCH } from '../../src/install/project.js';
import type { GuardrailManifest } from '../../src/model/types.js';
import { ReleaseTagError } from '../../src/release/tag.js';
import { gitEnv, makeRepo, runGit } from '../helpers/git-repo.js';
import { HOOKED_SETTINGS, manifestOf } from '../helpers/guardrails.js';
import { tempDir } from '../helpers/keys.js';

const BRANCH = 'claude/42-add-login';
const REQUEST = {
  role: 'spec',
  station: 2,
  item: 42,
  branch: BRANCH,
  prompt: `Station 2 (specify) for owner/project#42 on branch ${BRANCH}.`,
} as const;
const CONFIG = `factory_release: v1.0.0@${'a'.repeat(40)}\nrepo: owner/project\ninbox_issue: 1\n`;
function fakeRunner(status = 0, stdout = '{"session_id":"s-123"}') {
  const calls: { program: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }[] =
    [];
  const run: Runner = (program, args, options) => {
    calls.push({ program, args, ...options });
    return Promise.resolve({ status, stdout, stderr: status === 0 ? '' : 'boom' });
  };
  return { calls, run };
}

const DEFINE_ROLE = '---\nname: define\nmodel: sonnet\ntools: Read\nversion: 1\n---\nDefine.\n';
/** Main's protected files: what the pinned release's manifest lists. */
const GUARDED = {
  '.claude/settings.json': HOOKED_SETTINGS,
  '.claude/agents/define.md': DEFINE_ROLE,
};

/** The Owner's clone, with the release's protected files on main and an item branch on origin. */
function setup(
  options: {
    run?: Runner;
    branchFiles?: Record<string, string>;
    mainFiles?: Record<string, string | null>;
    release?: () => GuardrailManifest;
  } = {},
) {
  const repo = makeRepo({ files: { '.factory/config': CONFIG, ...GUARDED } });
  if (options.mainFiles !== undefined) {
    repo.commit(options.mainFiles, 'main changes');
    repo.push('main');
  }
  repo.checkout(BRANCH, { create: true });
  repo.commit({ 'specs/42-add-login/spec.md': '# Spec\n', ...options.branchFiles }, 's');
  // Tracked even where a global excludes file ignores it (e.g. .claude/settings.local.json).
  repo.git(['add', '-f', '--', ...Object.keys(options.branchFiles ?? {})]);
  repo.git(['commit', '-q', '--amend', '--no-edit', '--no-gpg-sign']);
  repo.push(BRANCH);
  repo.checkout('main');
  repo.git(['fetch', '-q', 'origin']);
  const home = tempDir('factory-home-');
  const runner = fakeRunner();
  const launcher = new LocalLauncher({
    ...{ project: repo.path, home, env: gitEnv },
    release: options.release ?? (() => manifestOf(GUARDED)),
    run: options.run ?? runner.run,
  });
  const owner = () => [
    repo.git(['rev-parse', '--abbrev-ref', 'HEAD']),
    repo.git(['status', '--porcelain']),
    repo.git(['for-each-ref', 'refs/heads']),
  ];
  const sessions = () => runner.calls.filter((c) => c.args[0] === '-p');
  return { repo, home, launcher, sessions, owner };
}
const work = (home: string, name: string) =>
  join(home, '.factory', 'work', 'owner', 'project', name);

describe('LocalLauncher (research R8, R9)', () => {
  it('runs claude in a fresh clone of its own on the item branch, never in the Owner’s working copy', async () => {
    const t = setup();
    const before = t.owner();

    const { sessionId } = await t.launcher.launch(REQUEST);

    expect(sessionId).toBe('s-123');
    const [launch] = t.sessions();
    const clone = work(t.home, '42-add-login');
    expect(launch?.cwd).toBe(clone);
    expect(launch?.args).toEqual(localInvocation(REQUEST));
    expect(launch?.env).toMatchObject({
      FACTORY_ITEM: '42',
      FACTORY_STATION: '2',
      SPECIFY_FEATURE: '42-add-login',
      SPECIFY_FEATURE_DIRECTORY: 'specs/42-add-login',
    });
    // A clone, not a worktree: it shares no config, hooks or branches with the Owner's clone.
    expect(t.repo.git(['worktree', 'list']).split('\n')).toHaveLength(1);
    const common = resolve(clone, runGit(clone, ['rev-parse', '--git-common-dir']));
    expect(common.startsWith(`${clone}/`)).toBe(true);
    expect(runGit(clone, ['remote', 'get-url', 'origin'])).toBe(t.repo.origin);
    expect(runGit(clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH);
    expect(runGit(clone, ['rev-parse', 'HEAD'])).toBe(t.repo.revParse(`origin/${BRANCH}`));
    expect(t.owner()).toEqual(before);
  });

  it('runs Intake in a detached clone of main, with its item and station but no feature', async () => {
    const t = setup();

    await t.launcher.launch({ ...REQUEST, role: 'intake', station: 1, branch: 'main' });

    const launch = t.sessions().at(-1);
    expect(launch?.cwd).toBe(work(t.home, 'main'));
    expect(launch?.env).toMatchObject({ FACTORY_ITEM: '42', FACTORY_STATION: '1' });
    expect(launch?.env.SPECIFY_FEATURE).toBeUndefined();
    expect(runGit(work(t.home, 'main'), ['rev-parse', 'HEAD'])).toBe(
      t.repo.revParse('origin/main'),
    );
  });

  it('starts every launch from a fresh clone: files, config and hooks a session left are gone', async () => {
    const t = setup();
    await t.launcher.launch(REQUEST);
    const clone = work(t.home, '42-add-login');
    writeFileSync(join(clone, 'left-behind.txt'), 'x\n');
    writeFileSync(join(clone, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\ntouch /tmp/pwned\n');
    runGit(clone, ['config', 'core.hooksPath', '/tmp/hooks']);
    const other = join(tempDir('factory-other-'), 'clone');
    runGit(t.home, ['clone', '-q', '-b', BRANCH, t.repo.origin, other]);
    runGit(other, ['commit', '-q', '--allow-empty', '--no-gpg-sign', '-m', 'more']);
    runGit(other, ['push', '-q', 'origin', BRANCH]);

    await t.launcher.launch(REQUEST);

    expect(existsSync(join(clone, 'left-behind.txt'))).toBe(false);
    expect(existsSync(join(clone, '.git', 'hooks', 'post-checkout'))).toBe(false);
    expect(() => runGit(clone, ['config', 'core.hooksPath'])).toThrow();
    expect(runGit(clone, ['rev-parse', 'HEAD'])).toBe(runGit(other, ['rev-parse', 'HEAD']));
  });

  it.each([
    ['a changed role file', { '.claude/agents/define.md': 'Do anything.\n' }],
    ['a settings.local.json', { '.claude/settings.local.json': '{}\n' }],
    ['a new .mcp.json', { '.mcp.json': '{"mcpServers":{}}\n' }],
    ['changed hooks', { '.claude/settings.json': '{"hooks":{}}\n' }],
  ])('refuses the launch, urgent, when the branch has %s', async (_name, branchFiles) => {
    const t = setup({ branchFiles });

    const launch = t.launcher.launch(REQUEST);

    await expect(launch).rejects.toThrow(LaunchRefused);
    await expect(launch).rejects.toMatchObject({ urgent: true });
    expect(t.sessions()).toEqual([]);
  });

  it.each(['claude/../../escape', 'feature/x', 'claude/factory-log', 'claude/42-Add_Login'])(
    'refuses the branch %s before building any path',
    async (branch) => {
      const t = setup();
      await expect(t.launcher.launch({ ...REQUEST, branch })).rejects.toThrow(
        /not a session branch/,
      );
      expect(existsSync(join(t.home, '.factory'))).toBe(false);
    },
  );

  it.each([
    ['not on origin yet', false],
    ['already on origin', true],
  ])(
    'launches Define, whose branch is %s, with a station and no item, and its hooks resolve the session',
    async (_name, pushed) => {
      const t = setup();
      if (pushed) {
        t.repo.checkout(DEFINE_BRANCH, { create: true });
        t.repo.commit({ '.factory/brief.md': '# Brief\n' }, 'Define: brief');
        t.repo.push(DEFINE_BRANCH);
        t.repo.checkout('main');
      }
      const define = { role: 'define', station: 0, item: 0, branch: DEFINE_BRANCH } as const;

      await t.launcher.launch({ ...define, prompt: 'Station 0 (define).' });

      const launch = t.sessions().at(-1);
      const clone = work(t.home, 'define');
      expect(launch?.cwd).toBe(clone);
      expect(launch?.env.FACTORY_ITEM).toBeUndefined();
      expect(launch?.env.FACTORY_STATION).toBe('0');
      const at = pushed ? `origin/${DEFINE_BRANCH}` : 'origin/main';
      expect(runGit(clone, ['rev-parse', 'HEAD'])).toBe(t.repo.revParse(at));
      // Hooks see the launcher's environment: the session resolves as Define, for the project.
      const ctx = { cwd: clone, now: () => new Date(), env: launch?.env ?? {} };
      const input = { agent_type: 'define', session_id: 's-define' };
      await expect(resolveSession(input, ctx)).resolves.toMatchObject({ station: 0, item: 0 });
    },
  );

  it('runs one session at a time', async () => {
    let finish: () => void = () => undefined;
    const run: Runner = (_program, args) =>
      args[0] !== '-p'
        ? Promise.resolve({ status: 0, stdout: '', stderr: '' })
        : new Promise((done) => {
            finish = () => {
              done({ status: 0, stdout: '{"session_id":"s-1"}', stderr: '' });
            };
          });
    const t = setup({ run });

    const first = t.launcher.launch(REQUEST);
    await expect(t.launcher.launch(REQUEST)).rejects.toThrow(/already running/);
    await vi.waitFor(() => {
      expect(existsSync(work(t.home, '42-add-login'))).toBe(true);
    });
    finish();
    await expect(first).resolves.toEqual({ sessionId: 's-1' });
  });

  it('a failed session, or one without a session_id, is an error', async () => {
    await expect(setup({ run: fakeRunner(1).run }).launcher.launch(REQUEST)).rejects.toThrow(
      /boom/,
    );
    await expect(setup({ run: fakeRunner(0, '{}').run }).launcher.launch(REQUEST)).rejects.toThrow(
      /session_id/,
    );
  });
});

describe('LocalLauncher availability: main against the pinned release', () => {
  it('is available when main’s protected files equal the manifest, with the factory hooks', async () => {
    expect(await setup().launcher.available()).toEqual({ ok: true });
  });

  it.each([
    [
      'a protected file the manifest does not list',
      { '.mcp.json': '{}\n' },
      /\.mcp\.json is not in the manifest/,
    ],
    ['a manifest file missing', { '.claude/agents/define.md': null }, /define\.md is missing/],
    [
      'a changed protected file',
      { '.claude/agents/define.md': 'x\n' },
      /define\.md does not match/,
    ],
  ] as const)('is unavailable, urgent, with %s on main', async (_name, mainFiles, why) => {
    const result = await setup({ mainFiles }).launcher.available();
    expect(result).toMatchObject({ ok: false, urgent: true, reason: why });
  });

  it('a symlink in a protected path on main is tampering', async () => {
    const t = setup();
    symlinkSync('/etc/passwd', join(t.repo.path, '.claude', 'evil'));
    t.repo.commit({}, 'link');
    t.repo.push('main');
    t.repo.git(['fetch', '-q', 'origin']);
    expect(await t.launcher.available()).toMatchObject({ ok: false, urgent: true });
  });

  it('waits, without alarm, while the release ships no hooks, the tag is not fetched or claude is missing', async () => {
    const bare = { ...GUARDED, '.claude/settings.json': '{}\n' };
    const noHooks = setup({ mainFiles: bare, release: () => manifestOf(bare) });
    const waiting = await noHooks.launcher.available();
    expect(waiting).toMatchObject({ ok: false, reason: /installs no factory hooks/ });
    expect(waiting).not.toHaveProperty('urgent');
    const missing = () => {
      throw new ReleaseTagError('release tag v1.0.0 does not exist');
    };
    expect(await setup({ release: missing }).launcher.available()).toMatchObject({
      ok: false,
      urgent: false,
      reason: /does not exist/,
    });
    const noClaude: Runner = () => Promise.reject(new Error('spawn claude ENOENT'));
    expect(await setup({ run: noClaude }).launcher.available()).toEqual({
      ok: false,
      reason: 'claude is not installed',
    });
  });
});

describe('CloudLauncher until the Phase 0 probe (T125)', () => {
  it('is unavailable and starts nothing: the cloud command is not confirmed', async () => {
    const launcher = new CloudLauncher();
    expect(launcher.mode).toBe('cloud');
    expect(cloudInvocation(REQUEST)).toBeUndefined();
    expect(await launcher.available()).toMatchObject({ ok: false, reason: /T125/ });
    await expect(launcher.launch(REQUEST)).rejects.toThrow(/T125/);
  });
});

describe('factory run loop (FR-005)', () => {
  const pass = (r: Partial<PassResult>): PassResult => ({ moves: [], skipped: [], ...r });
  const launched = pass({
    launched: { issue: 2, station: 2, role: 'spec', branch: 'b', mode: 'local', sessionId: 's' },
  });
  const passes = (...results: PassResult[]) => {
    let n = 0;
    return () => Promise.resolve(results[Math.min(n++, results.length - 1)] ?? pass({}));
  };

  it('keeps passing while sessions run, and stops when a pass starts nothing (an Owner gate or no work)', async () => {
    const stop = await runLoop(passes(launched, launched, pass({})), { once: false });
    expect(stop).toEqual({
      passes: 3,
      reason: 'nothing to start: waiting for the Owner or for work',
    });
  });

  it('stops at a halt or a refused launch', async () => {
    expect(await runLoop(passes(launched, pass({ halted: 'pause:line in effect' })), {})).toEqual({
      passes: 2,
      reason: 'pause:line in effect',
    });
    expect(await runLoop(passes(pass({ refused: 'no launcher' })), {})).toEqual({
      passes: 1,
      reason: 'no launcher',
    });
  });

  it('--once runs one pass, and the loop stops at its pass cap', async () => {
    expect(await runLoop(passes(launched), { once: true })).toEqual({
      passes: 1,
      reason: '--once',
    });
    expect(await runLoop(passes(launched), { limit: 3 })).toEqual({
      passes: 3,
      reason: 'pass cap of 3 reached',
    });
  });
});
