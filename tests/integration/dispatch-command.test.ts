import { copyFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderComment } from '../../src/approvals/record.js';
import { ownerKeyPath, sign } from '../../src/approvals/sign.js';
import { runCli } from '../../src/cli/commands.js';
import { runProcess } from '../../src/dispatcher/launcher/local.js';
import { STATES, type ApprovalRecord } from '../../src/model/types.js';
import { FakeLauncher } from '../helpers/fake-launcher.js';
import { readState, seedState } from '../helpers/fake-gh.js';
import { makeRepo, mergeBrief } from '../helpers/git-repo.js';
import { makeKeys, tempDir, type TestKeys } from '../helpers/keys.js';

const REPO = 'owner/project';
const BRANCH = 'claude/2-add-login';
const BEFORE = '2026-10-01T08:00:00Z';
const LABELS = [...STATES.map((s) => `state:${s}`), 'owner:approved'].map((name) => ({
  name,
  color: 'ededed',
  description: '',
}));

let owner: TestKeys;
beforeAll(() => {
  owner = makeKeys();
});

function setup(options: { agents?: 'local' | 'cloud'; unsignedMain?: boolean } = {}) {
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
  const project = makeRepo({ files: { '.factory/config': config }, signWith: owner });
  mergeBrief(project, { signWith: owner });
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
  const cli = async (argv: string[], over: { launchers?: boolean; cwd?: string } = {}) => {
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
      ...(over.launchers === false ? {} : { launchers: { local } }),
    });
    return { code, stdout: out.join(''), stderr: err.join('') };
  };
  return { cli, local };
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
    const inbox = readState().repos[REPO]?.issues.find((i) => i.number === 1)?.comments ?? [];
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.body).toMatch(/urgency=info kind=launcher-unavailable/);
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
