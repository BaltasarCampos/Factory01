import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { runCli, type CliDeps, type CommandSpec } from '../../src/cli/commands.js';
import { ExitCode } from '../../src/cli/env.js';
import {
  alert,
  inboxReadPath,
  parseAlert,
  projectUnreadAlerts,
  unreadAlerts,
} from '../../src/notify/inbox.js';
import { readState, seedState } from '../helpers/fake-gh.js';
import { tempDir } from '../helpers/keys.js';

const REPO = 'owner/project';
const INBOX = 1;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MARKER =
  /^<!-- factory-alert id=([0-9A-HJKMNP-TV-Z]{26}) urgency=(urgent|info) kind=([a-z-]+) -->\n/;
const SHA40 = '3f9a0c1d2e3f4a5b6c7d8e9f0011223344556677';

function setup() {
  seedState({ repos: { [REPO]: { issues: [{ number: INBOX, title: 'Owner inbox' }] } } });
  return { repo: REPO, inboxIssue: INBOX, home: tempDir() };
}

const inboxComments = () => readState().repos[REPO]?.issues[0]?.comments ?? [];
const workflowRuns = () => readState().repos[REPO]?.workflowRuns ?? [];

async function cli(argv: string[], deps: Partial<CliDeps>) {
  const out: string[] = [];
  const code = await runCli(argv, {
    stdout: { write: (s: string) => void out.push(s) },
    stderr: { write: (s: string) => void out.push(s) },
    env: { PATH: process.env.PATH ?? '' },
    stdinIsTTY: true,
    unreadAlerts: () => Promise.resolve([]),
    ...deps,
  });
  return { code, out: out.join('') };
}

describe('Owner notification (AC-075)', () => {
  it('an info alert becomes one inbox comment headed by its marker, with no workflow run', async () => {
    const ctx = setup();
    const id = await alert(ctx, {
      urgency: 'info',
      kind: 'gate-failed',
      text: 'Build failed for #12',
      evidence: ['https://github.com/owner/project/actions/runs/7'],
    });
    expect(id).toMatch(ULID);
    const [comment] = inboxComments();
    expect(comment?.body).toMatch(MARKER);
    expect(MARKER.exec(comment?.body ?? '')?.slice(1)).toEqual([id, 'info', 'gate-failed']);
    expect(comment?.body).toContain('Build failed for #12');
    expect(comment?.body).toContain('https://github.com/owner/project/actions/runs/7');
    expect(workflowRuns()).toEqual([]);
  });

  it('an urgent alert also runs owner-alert.yml with its id, after the comment exists', async () => {
    const ctx = setup();
    const id = await alert(ctx, {
      urgency: 'urgent',
      kind: 'tampering',
      text: 'owner:approved on #3 has no record',
    });
    expect(inboxComments()).toHaveLength(1);
    expect(workflowRuns()).toEqual([
      {
        workflow: 'owner-alert.yml',
        inputs: { alert_id: id },
        createdAt: expect.any(String) as string,
      },
    ]);
  });

  it('ids are unique and sort by creation time', async () => {
    const ctx = setup();
    const a = await alert(ctx, { urgency: 'info', kind: 'note', text: 'a' }, { now: () => 1_000 });
    const b = await alert(ctx, { urgency: 'info', kind: 'note', text: 'b' }, { now: () => 2_000 });
    expect(a < b).toBe(true);
    expect(a).not.toBe(b);
  });

  it('refuses a kind outside [a-z-] before posting anything', async () => {
    const ctx = setup();
    await expect(alert(ctx, { urgency: 'info', kind: 'x --> <!--', text: 't' })).rejects.toThrow();
    expect(inboxComments()).toEqual([]);
  });

  it('factory inbox lists unread alerts then marks them read; --all lists every alert', async () => {
    const ctx = setup();
    await alert(ctx, { urgency: 'urgent', kind: 'tampering', text: 'first' });
    await alert(ctx, { urgency: 'info', kind: 'gate-failed', text: 'second' });
    expect((await unreadAlerts(ctx)).map((a) => a.text)).toEqual(['first', 'second']);

    const project = projectDir();
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: ctx.home,
      FAKE_GH_STATE: process.env.FAKE_GH_STATE,
    };
    const first = await cli(['inbox'], { env, cwd: project });
    expect(first.code).toBe(ExitCode.Ok);
    expect(first.out).toMatch(/URGENT\s+tampering: first[\s\S]*info\s+gate-failed: second/);
    expect(readFileSync(inboxReadPath(ctx.home), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(await unreadAlerts(ctx)).toEqual([]);

    const second = await cli(['inbox'], { env, cwd: project });
    expect(second.out).toMatch(/no unread alerts/i);
    const all = await cli(['inbox', '--all'], { env, cwd: project });
    expect(all.out).toMatch(/first[\s\S]*second/);
  });

  it('every other command shows unread alerts before its own output', async () => {
    const ctx = setup();
    await alert(ctx, { urgency: 'urgent', kind: 'tampering', text: 'label forged' });
    const project = projectDir();
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: ctx.home,
      FAKE_GH_STATE: process.env.FAKE_GH_STATE,
    };
    const own: CommandSpec = {
      summary: 'stub',
      usage: 'factory stub',
      laptopOnly: false,
      requires: [],
      options: {},
      positionals: { min: 0, max: 0 },
      run: (c) => (c.io.stdout.write('own output\n'), Promise.resolve(0)),
    };
    const run = await cli(['stub'], {
      env,
      commands: { stub: own },
      unreadAlerts: () => projectUnreadAlerts(project, env),
    });
    expect(run.out).toMatch(
      /^Owner inbox: 1 unread alert\n {2}URGENT {2}tampering: label forged\n/,
    );
    expect(run.out.indexOf('label forged')).toBeLessThan(run.out.indexOf('own output'));
  });

  it('outside a project there is no inbox to read', async () => {
    setup();
    expect(await projectUnreadAlerts(tempDir(), { HOME: tempDir() })).toEqual([]);
  });

  it('ignores comments without a well-formed marker and strips control characters', () => {
    const at = '2026-10-02T09:00:00Z';
    const comment = (body: string) => ({ id: '1', author: 'owner', body, createdAt: at });
    expect(parseAlert(comment('plain comment'))).toBeUndefined();
    expect(
      parseAlert(
        comment('text\n<!-- factory-alert id=01J0000000000000000000000A urgency=info kind=x -->'),
      ),
    ).toBeUndefined();
    expect(
      parseAlert(comment('<!-- factory-alert id=short urgency=info kind=x -->\nt')),
    ).toBeUndefined();
    expect(
      parseAlert(
        comment('<!-- factory-alert id=01J0000000000000000000000A urgency=loud kind=x -->\nt'),
      ),
    ).toBeUndefined();
    expect(
      parseAlert(
        comment(
          '<!-- factory-alert id=01J0000000000000000000000A urgency=info kind=x -->\n\n\u001b[2Jhi\u0007 there\nmore',
        ),
      ),
    ).toEqual({
      id: '01J0000000000000000000000A',
      urgency: 'info',
      kind: 'x',
      text: '[2Jhi there',
    });
  });
});

describe('owner-alert workflow template (AC-075)', () => {
  const file = fileURLToPath(new URL('../../factory/workflows/owner-alert.yml', import.meta.url));
  const workflow = parseYaml(readFileSync(file, 'utf8')) as {
    on: { workflow_dispatch: { inputs: Record<string, { required: boolean }> } };
    permissions: Record<string, string>;
    jobs: Record<string, { steps: { run: string; env?: Record<string, string> }[] }>;
  };

  it('is dispatched by hand with a required alert_id and reads nothing else', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on.workflow_dispatch.inputs.alert_id?.required).toBe(true);
    expect(workflow.permissions).toEqual({});
  });

  it('always fails, so GitHub emails the Owner, and never splices the input into the script', () => {
    const steps = Object.values(workflow.jobs).flatMap((j) => j.steps);
    expect(steps).toHaveLength(1);
    const step = steps[0];
    expect(step?.run).not.toContain('${{');
    const result = spawnSync('bash', ['-e', '-c', step?.run ?? ''], {
      env: {
        ...step?.env,
        ALERT_ID: '01J0000000000000000000000A; echo pwned',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: REPO,
      },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('01J0000000000000000000000A; echo pwned');
    expect(result.stdout).not.toMatch(/^pwned$/m);
  });
});

function projectDir(): string {
  const dir = tempDir();
  mkdirSync(join(dir, '.factory'));
  const config = [
    `factory_release: v1.0.0@${SHA40}`,
    'agents: local',
    'profile: typescript',
    `repo: ${REPO}`,
    `inbox_issue: ${String(INBOX)}`,
  ];
  writeFileSync(join(dir, '.factory', 'config'), `${config.join('\n')}\n`);
  return dir;
}
