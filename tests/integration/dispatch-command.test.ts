import { copyFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderComment } from '../../src/approvals/record.js';
import { ownerKeyPath, sign } from '../../src/approvals/sign.js';
import { runCli } from '../../src/cli/commands.js';
import { LocalLauncher, runProcess } from '../../src/dispatcher/launcher/local.js';
import type { Launchers } from '../../src/dispatcher/launcher/types.js';
import { STATES, type ApprovalRecord, type GuardrailManifest } from '../../src/model/types.js';
import { FakeLauncher } from '../helpers/fake-launcher.js';
import { readState, seedState } from '../helpers/fake-gh.js';
import { gitEnv, makeRepo, mergeBrief } from '../helpers/git-repo.js';
import { HOOKED_SETTINGS, manifestOf } from '../helpers/guardrails.js';
import { makeKeys, makeOtherKeys, tempDir, type TestKeys } from '../helpers/keys.js';

const REPO = 'owner/project';
const BRANCH = 'claude/2-add-login';
const BEFORE = '2026-10-01T08:00:00Z';
const LABELS = [...STATES.map((s) => `state:${s}`), 'owner:approved'].map((name) => ({
  name,
  color: 'ededed',
  description: '',
}));

let owner: TestKeys;
let other: TestKeys;
beforeAll(() => {
  owner = makeKeys();
  other = makeOtherKeys();
});

interface Setup {
  agents?: 'local' | 'cloud';
  unsignedMain?: boolean;
  /** `.claude/settings.json` on main. */
  settings?: string;
  /** `.claude/settings.json` on an item branch pushed before the pass. */
  branchSettings?: string;
}

function setup(options: Setup = {}) {
  const factory = makeRepo({
    files: { allowed_signers: `${owner.allowedSignersLine}\n`, revoked_keys: '' },
  });
  const config = [
    `factory_release: v1.0.0@${factory.revParse('HEAD')}`,
    `repo: ${REPO}`,
    'inbox_issue: 1',
    `agents: ${options.agents ?? 'local'}`,
    '',
  ].join('\n');
  const files = {
    '.factory/config': config,
    ...(options.settings === undefined ? {} : { '.claude/settings.json': options.settings }),
  };
  const project = makeRepo({ files, signWith: owner });
  mergeBrief(project, { signWith: owner });
  if (options.branchSettings !== undefined) {
    project.checkout(BRANCH, { create: true });
    project.commit({ '.claude/settings.json': options.branchSettings }, 'changed hooks');
    project.push(BRANCH);
    project.checkout('main');
  }
  if (options.unsignedMain) {
    project.commit({ 'x.md': 'pushed with the merge button\n' }, 'unsigned');
    project.push('main');
  }
  const record: ApprovalRecord = {
    ...{ repo: REPO, issue: 2, gate: 'approved', tier: 2, branch: BRANCH },
    ...{ timestamp: BEFORE, nonce: randomBytes(16).toString('hex') },
  };
  const body = renderComment(record, sign(record, owner.privateKey, { stdinIsTTY: true }));
  seedState({
    repos: {
      [REPO]: {
        origin: project.origin,
        labels: LABELS,
        issues: [
          { number: 1, title: 'Owner inbox' },
          {
            number: 2,
            title: 'Add login',
            labels: ['type:feature', 'priority:p2', 'tier:2', 'owner:approved'],
            events: [
              {
                event: 'labeled' as const,
                label: { name: 'owner:approved' },
                actor: { login: 'owner' },
              },
            ].map((e) => ({ ...e, created_at: BEFORE })),
            comments: [{ id: 5000, author: 'owner', body, createdAt: BEFORE }],
          },
        ],
      },
    },
  });
  const home = tempDir('factory-home-');
  mkdirSync(join(home, '.factory', 'keys'), { recursive: true });
  copyFileSync(owner.publicKeyPath, `${ownerKeyPath(home)}.pub`);
  const local = new FakeLauncher('local');
  /** A real local launcher against this release manifest; sessions are recorded, not run. */
  const sessions: { args: readonly string[]; cwd: string }[] = [];
  const realLocal = (manifest: GuardrailManifest) =>
    new LocalLauncher({
      ...{ project: project.path, home, env: gitEnv },
      release: () => manifest,
      run: (_program, args, { cwd }) => {
        sessions.push({ args, cwd });
        return Promise.resolve({ status: 0, stdout: '{"session_id":"s-9"}', stderr: '' });
      },
    });
  const cli = async (
    argv: string[],
    over: { launchers?: Launchers | false; cwd?: string } = {},
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, FACTORY_SOURCE: factory.path };
    delete env.CLAUDE_CODE_REMOTE;
    const code = await runCli(argv, {
      stdout: { write: (s: string) => void out.push(s) },
      stderr: { write: (s: string) => void err.push(s) },
      env,
      stdinIsTTY: false,
      cwd: over.cwd ?? project.path,
      unreadAlerts: () => Promise.resolve([]),
      now: () => new Date('2026-10-01T10:00:00Z'),
      ...(over.launchers === false ? {} : { launchers: over.launchers ?? { local } }),
    });
    return { code, stdout: out.join(''), stderr: err.join('') };
  };
  const inbox = () => readState().repos[REPO]?.issues.find((i) => i.number === 1)?.comments ?? [];
  const checkout = () => [
    project.git(['rev-parse', '--abbrev-ref', 'HEAD']),
    project.git(['status', '--porcelain']),
  ];
  /** Tag the pinned release `v1.0.0`, its message the manifest, signed with `key` if given. */
  const tagRelease = (key?: TestKeys, commit = factory.revParse('HEAD')) => {
    const pin = factory.revParse('HEAD');
    const message = JSON.stringify({ release: 'v1.0.0', commit, files: {} });
    const signing = key ? ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${key.privateKey}`] : [];
    factory.git([...signing, 'tag', key ? '-s' : '-a', '-m', message, 'v1.0.0', pin]);
  };

  return { cli, local, realLocal, sessions, inbox, checkout, home, tagRelease };
}

describe('factory dispatch and factory run (contracts/cli.md)', { timeout: 60_000 }, () => {
  it('factory dispatch runs one pass in the project clone and reports what it did', async () => {
    const t = setup();

    const r = await t.cli(['dispatch']);

    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toContain('#2 new → triaged');
    expect(r.stdout).toContain(`started spec (station 2) for #2 on ${BRANCH}: local session`);
    expect(t.local.launches).toHaveLength(1);
  });

  it('factory run passes until a pass starts nothing', async () => {
    const t = setup();

    const r = await t.cli(['run']);

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/stopped after 2 passes: nothing to start/);
    expect(t.local.launches).toHaveLength(1);
  });

  it('without launchers from the caller, an agents: cloud project starts no session and the Owner gets one info alert (T125)', async () => {
    const t = setup({ agents: 'cloud' });

    const r = await t.cli(['dispatch'], { launchers: false });
    await t.cli(['dispatch'], { launchers: false });

    expect(r.stdout).toContain('no session started: the cloud launcher is unavailable');
    expect(t.inbox()).toHaveLength(1);
    expect(t.inbox()[0]?.body).toMatch(/urgency=info kind=launcher-unavailable/);
  });

  it('halts when main has a first-parent commit the Owner did not sign (AC-073)', async () => {
    const t = setup({ unsignedMain: true });

    const r = await t.cli(['dispatch']);

    expect(r.stdout).toContain('halted: main has a first-parent commit not signed by the Owner');
    expect(t.local.launches).toEqual([]);
  });

  it('refuses outside a project clone, and --attack-suite is not in this build', async () => {
    const t = setup();
    expect((await t.cli(['dispatch'], { cwd: tempDir('elsewhere-') })).code).toBe(1);
    expect((await t.cli(['dispatch', '--attack-suite'])).code).toBe(2);
  });
});

describe('local sessions wait for the guards (slice 28)', { timeout: 60_000 }, () => {
  it('a project whose release ships no factory hooks starts no local session, with one info alert', async () => {
    const t = setup();
    const local = t.realLocal(manifestOf({}));

    const r = await t.cli(['dispatch'], { launchers: { local } });
    await t.cli(['dispatch'], { launchers: { local } });

    expect(r.stdout).toMatch(
      /no session started: the local launcher is unavailable: .*no factory hooks/,
    );
    expect(t.sessions).toEqual([]);
    expect(t.inbox()).toHaveLength(1);
    expect(t.inbox()[0]?.body).toMatch(/urgency=info kind=launcher-unavailable/);
  });

  it('with hooks matching the pinned release, the session runs in its own clone and the Owner’s checkout is unchanged', async () => {
    const t = setup({ settings: HOOKED_SETTINGS });
    const local = t.realLocal(manifestOf({ '.claude/settings.json': HOOKED_SETTINGS }));
    const before = t.checkout();

    const r = await t.cli(['dispatch'], { launchers: { local } });

    expect(r.stdout).toContain(`started spec (station 2) for #2 on ${BRANCH}: local session s-9`);
    const worktree = join(t.home, '.factory', 'work', 'owner', 'project', '2-add-login');
    expect(t.sessions.filter((s) => s.args[0] === '-p').map((s) => s.cwd)).toEqual([worktree]);
    expect(t.checkout()).toEqual(before);
    expect(t.inbox()).toEqual([]);
  });

  it.each([
    ['not fetched', 'none', /does not exist/, 'info'],
    ['not signed', 'unsigned', /is not signed/, 'urgent'],
    ['signed by another key', 'other', /not signed by a listed, non-revoked Owner key/, 'urgent'],
    ['signed by the Owner, with no hooks yet', 'owner', /installs no factory hooks/, 'info'],
    [
      'signed by the Owner, its manifest for another commit',
      'stale',
      /is not for v1\.0\.0@/,
      'urgent',
    ],
  ] as const)(
    'by default, the local launcher checks the release tag’s signature: a tag %s',
    async (_name, tag, why, urgency) => {
      const t = setup();
      if (tag === 'unsigned') t.tagRelease();
      if (tag === 'other') t.tagRelease(other);
      if (tag === 'owner') t.tagRelease(owner);
      if (tag === 'stale') t.tagRelease(owner, 'c'.repeat(40));

      const r = await t.cli(['dispatch'], { launchers: false });

      expect(r.stdout).toMatch(why);
      expect(t.inbox()).toHaveLength(1);
      expect(t.inbox()[0]?.body).toMatch(
        urgency === 'urgent'
          ? /urgency=urgent kind=tampering/
          : /urgency=info kind=launcher-unavailable/,
      );
    },
  );

  it('main clean but an item branch with changed hooks: no session and one urgent alert', async () => {
    const t = setup({ settings: HOOKED_SETTINGS, branchSettings: '{"hooks":{}}\n' });
    const local = t.realLocal(manifestOf({ '.claude/settings.json': HOOKED_SETTINGS }));

    const r = await t.cli(['dispatch'], { launchers: { local } });
    await t.cli(['dispatch'], { launchers: { local } });

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      /no session started: .*claude\/2-add-login: .*settings\.json does not match/,
    );
    expect(t.sessions.filter((s) => s.args[0] === '-p')).toEqual([]);
    expect(t.inbox()).toHaveLength(1);
    expect(t.inbox()[0]?.body).toMatch(/urgency=urgent kind=tampering/);
  });

  it('hook files that differ from the pinned release start no session and raise an urgent alert', async () => {
    const t = setup({ settings: '{"hooks":{}}\n' });
    const local = t.realLocal(manifestOf({ '.claude/settings.json': HOOKED_SETTINGS }));

    const r = await t.cli(['dispatch'], { launchers: { local } });

    expect(r.stdout).toMatch(/settings.json does not match the manifest/);
    expect(t.sessions).toEqual([]);
    expect(t.inbox()[0]?.body).toMatch(/urgency=urgent kind=tampering/);
  });
});

describe('local session process runner', () => {
  it('collects the exit status and output of the program', async () => {
    const script = 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)';
    const r = await runProcess(process.execPath, ['-e', script], {
      cwd: tempDir('run-'),
      env: process.env,
    });
    expect(r).toEqual({ status: 3, stdout: 'out', stderr: 'err' });
  });
});
