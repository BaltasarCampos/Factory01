import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { nonceLedgerPath } from '../../src/approvals/nonces.js';
import { extractFromComment, newNonce, parse, renderComment } from '../../src/approvals/record.js';
import { ownerKeyPath, sign } from '../../src/approvals/sign.js';
import { verifySignature } from '../../src/approvals/verify.js';
import { runCli } from '../../src/cli/commands.js';
import { listComments } from '../../src/github/comments.js';
import { timeline } from '../../src/github/timeline.js';
import { STATIONS, type ApprovalRecord } from '../../src/model/types.js';
import { derivePause, resumeEntries } from '../../src/pause/derive.js';
import { calls, readState, seedState, type FakeIssue, type FakePr } from '../helpers/fake-gh.js';
import { FakeClock } from '../helpers/fake-clock.js';
import { makeRepo, type TestRepo } from '../helpers/git-repo.js';
import { makeKeys, tempDir, writeKeyFiles, type TestKeys } from '../helpers/keys.js';

const REPO = 'owner/project';
const INBOX = 1;
const ITEM = 7;
const BRANCH = 'claude/7-add-login';
const PR_HEAD = '1c9d0e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3';
const LABELS = [
  'owner:approved',
  'owner:spec-approved',
  'owner:waiver',
  'tier:1',
  'tier:2',
  'tier:3',
  'pause:line',
  ...STATIONS.map((s) => `pause:${s}`),
].map((name) => ({ name, color: 'ededed', description: '' }));
const CONFIG = `factory_release: v1.0.0@${'a'.repeat(40)}\nrepo: ${REPO}\ninbox_issue: 1\nagents: cloud\n`;

let owner: TestKeys;
beforeAll(() => {
  owner = makeKeys();
});

const labeled = (name: string, at: string) => ({
  event: 'labeled' as const,
  label: { name },
  actor: { login: 'owner' },
  created_at: at,
});

/** A comment holding an Owner-signed `approved` record for the item, and its label event. */
function approvedItem(): Pick<FakeIssue, 'comments' | 'events' | 'labels'> {
  const record: ApprovalRecord = {
    repo: REPO,
    issue: ITEM,
    gate: 'approved',
    tier: 2,
    branch: BRANCH,
    timestamp: '2026-10-01T08:00:00Z',
    nonce: newNonce(),
  };
  const body = renderComment(record, sign(record, owner.privateKey, { stdinIsTTY: true }));
  return {
    comments: [{ id: 900, author: 'owner', body, createdAt: '2026-10-01T08:00:00Z' }],
    events: [labeled('owner:approved', '2026-10-01T08:01:00Z')],
    labels: ['tier:2', 'owner:approved'],
  };
}

interface Setup {
  issues?: (Partial<FakeIssue> & { number: number })[];
  prs?: (Partial<FakePr> & { number: number; headRefName: string })[];
  inbox?: Partial<FakeIssue>;
  /** GitHub's clock. */
  clock?: string;
  /** Leave the Owner key out of ~/.factory/keys, so signing fails. */
  noKey?: boolean;
  project?: (repo: TestRepo) => void;
}

function setup(options: Setup = {}) {
  seedState({
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    repos: {
      [REPO]: {
        labels: LABELS,
        issues: [
          { number: INBOX, title: 'Owner inbox', ...options.inbox },
          ...(options.issues ?? [{ number: ITEM, title: 'Add login', labels: ['tier:2'] }]),
        ],
        prs: options.prs ?? [],
      },
    },
  });
  const project = makeRepo({ files: { '.factory/config': CONFIG } });
  options.project?.(project);
  const home = tempDir('factory-home-');
  mkdirSync(join(home, '.factory', 'keys'), { recursive: true });
  writeFileSync(join(home, '.factory', 'allowed_signers'), `${owner.allowedSignersLine}\n`);
  if (!options.noKey) {
    copyFileSync(owner.privateKey, ownerKeyPath(home));
    chmodSync(ownerKeyPath(home), 0o600);
  }
  copyFileSync(owner.publicKeyPath, `${ownerKeyPath(home)}.pub`);
  const clock = new FakeClock('2026-10-02T09:00:00Z');

  const cli = async (argv: string[], over: { remote?: boolean } = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.CLAUDE_CODE_REMOTE;
    if (over.remote) env.CLAUDE_CODE_REMOTE = 'true';
    const code = await runCli(argv, {
      stdout: { write: (s: string) => void out.push(s) },
      stderr: { write: (s: string) => void err.push(s) },
      env,
      stdinIsTTY: over.remote !== true,
      cwd: project.path,
      unreadAlerts: () => Promise.resolve([]),
      now: () => clock.now(),
    });
    return { code, stdout: out.join(''), stderr: err.join('') };
  };
  const issue = (n: number) => {
    const found = readState().repos[REPO]?.issues.find((i) => i.number === n);
    if (found === undefined) throw new Error(`no issue #${String(n)}`);
    return found;
  };
  /** The record in the issue's newest comment, after checking its signature. */
  const posted = (n: number): ApprovalRecord => {
    const signed = extractFromComment(issue(n).comments.at(-1)?.body ?? '');
    expect(verifySignature(signed, writeKeyFiles([owner]))).toBe(true);
    return parse(signed.text);
  };
  return { cli, clock, home, project, issue, posted };
}

describe('factory approve (AC-068)', () => {
  it('approve <issue> signs gate approved with the confirmed tier, posts the record, then applies owner:approved', async () => {
    const t = setup();

    const r = await t.cli(['approve', String(ITEM)]);

    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('tier: 2');
    const body = t.issue(ITEM).comments.at(-1)?.body ?? '';
    expect(body.startsWith('<!-- factory-record v1 -->\n')).toBe(true);
    expect(t.posted(ITEM)).toEqual({
      repo: REPO,
      issue: ITEM,
      gate: 'approved',
      tier: 2,
      branch: BRANCH,
      timestamp: '2026-10-02T09:00:00Z',
      nonce: expect.stringMatching(/^[0-9a-f]{32}$/) as string,
    });
    expect(t.issue(ITEM).labels).toContain('owner:approved');
    // The record comment (the approval event, copied into events.jsonl with the branch) comes
    // before the label.
    const order = calls().map((c) => `${c[0] ?? ''} ${c[1] ?? ''}`);
    expect(order.indexOf('issue comment')).toBeLessThan(order.indexOf('issue edit'));
    const ledger = readFileSync(nonceLedgerPath(t.home), 'utf8');
    expect(ledger).toContain(`${t.posted(ITEM).nonce} ${REPO}#7/`);
  });

  it('approve <issue> --tier 1 confirms a tier other than the proposed one', async () => {
    const t = setup();
    expect((await t.cli(['approve', String(ITEM), '--tier', '1'])).code).toBe(0);
    expect(t.posted(ITEM).tier).toBe(1);
  });

  it('refuses without a single proposed tier: label or --tier', async () => {
    const t = setup({ issues: [{ number: ITEM, title: 'Add login' }] });
    const r = await t.cli(['approve', String(ITEM)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--tier/);
    expect(t.issue(ITEM).comments).toEqual([]);
  });

  it('approve <issue> spec binds the spec.md blob on the item branch', async () => {
    let specSha = '';
    const t = setup({
      issues: [{ number: ITEM, title: 'Add login', ...approvedItem() }],
      project: (repo) => {
        repo.checkout(BRANCH, { create: true });
        repo.commit({ 'specs/7-add-login/spec.md': '# Add login\n' }, 'spec');
        repo.push();
        specSha = repo.revParse(`${BRANCH}:specs/7-add-login/spec.md`);
        repo.checkout('main');
      },
    });

    const r = await t.cli(['approve', String(ITEM), 'spec']);

    expect(r.stderr).toBe('');
    expect(t.posted(ITEM)).toMatchObject({
      gate: 'spec-approved',
      tier: 2,
      branch: BRANCH,
      spec_sha: specSha,
    });
    expect(t.issue(ITEM).labels).toContain('owner:spec-approved');
  });

  it('approve <issue> spec refuses when the item has no verified owner:approved', async () => {
    const t = setup({ issues: [{ number: ITEM, title: 'Add login', labels: ['owner:approved'] }] });
    const r = await t.cli(['approve', String(ITEM), 'spec']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/owner:approved/);
    expect(t.issue(ITEM).labels).not.toContain('owner:spec-approved');
  });

  it('a code-gate waiver carries the PR head; a pre-build gate waiver does not', async () => {
    const t = setup({
      issues: [{ number: ITEM, title: 'Add login', ...approvedItem() }],
      prs: [{ number: 8, headRefName: BRANCH, headRefOid: PR_HEAD, isDraft: true }],
    });

    expect((await t.cli(['approve', String(ITEM), 'waiver', 'gate:coverage'])).code).toBe(0);
    expect(t.posted(ITEM)).toMatchObject({
      gate: 'waiver',
      waives: 'gate:coverage',
      tier: 2,
      branch: BRANCH,
      head: PR_HEAD,
    });

    expect((await t.cli(['approve', String(ITEM), 'waiver', 'gate:plan'])).code).toBe(0);
    const prebuild = t.posted(ITEM);
    expect(prebuild).toMatchObject({ waives: 'gate:plan', tier: 2, branch: BRANCH });
    expect(prebuild.head).toBeUndefined();
    // Each waiver gets its own label-add after its record.
    const adds = t.issue(ITEM).events.filter((e) => e.label.name === 'owner:waiver');
    expect(adds.filter((e) => e.event === 'labeled')).toHaveLength(2);
  });

  it('a waiver for a target that is not a work item omits tier and branch', async () => {
    const t = setup({ issues: [{ number: 9, title: 'Secret in log output' }] });

    const r = await t.cli(['approve', '9', 'waiver', 'finding:secret-in-log@src/app.ts:12']);

    expect(r.code).toBe(0);
    const record = t.posted(9);
    expect(record).toMatchObject({ gate: 'waiver', waives: 'finding:secret-in-log@src/app.ts:12' });
    expect(record.tier).toBeUndefined();
    expect(record.branch).toBeUndefined();
    expect(record.head).toBeUndefined();
  });

  it('never applies the label when signing fails (AC-068)', async () => {
    const t = setup({ noKey: true });

    const r = await t.cli(['approve', String(ITEM)]);

    expect(r.code).toBe(1);
    expect(t.issue(ITEM).comments).toEqual([]);
    expect(t.issue(ITEM).labels).not.toContain('owner:approved');
    expect(existsSync(nonceLedgerPath(t.home))).toBe(false);
  });
});

describe('factory pause and resume (AC-077)', () => {
  it.each([
    [[], 'pause:line'],
    [['build'], 'pause:build'],
  ])('pause %j adds %s without a signature, even in a cloud session', async (args, label) => {
    const t = setup();

    const r = await t.cli(['pause', ...args], { remote: true });

    expect(r.code).toBe(0);
    expect(t.issue(INBOX).labels).toEqual([label]);
    expect(t.issue(INBOX).comments).toEqual([]);
  });

  it('pause refuses an unknown station', async () => {
    const t = setup();
    expect((await t.cli(['pause', 'deploy'])).code).toBe(2);
  });

  const paused = (at: string) => ({
    labels: ['pause:line'],
    events: [labeled('pause:line', at)],
  });

  async function pauseState() {
    const comments = await listComments(REPO, INBOX);
    const keys = writeKeyFiles([owner]);
    const ctx = { keys, secondCopy: owner.publicKey, repo: REPO, inboxIssue: INBOX };
    return derivePause(await timeline(REPO, INBOX), resumeEntries(comments, ctx));
  }

  it('resume signs gate resume with its scope, posts it, and only then removes the label', async () => {
    const t = setup({ inbox: paused('2026-10-02T08:59:00Z') });

    const r = await t.cli(['resume']);

    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(t.posted(INBOX)).toMatchObject({
      gate: 'resume',
      issue: INBOX,
      scope: 'line',
      timestamp: '2026-10-02T09:00:00Z',
    });
    const order = calls().map((c) => `${c[0] ?? ''} ${c[1] ?? ''}`);
    expect(order.indexOf('issue comment')).toBeLessThan(order.indexOf('issue edit'));
    expect(t.issue(INBOX).labels).toEqual([]);
    expect((await pauseState()).line).toBe(false);
  });

  it('with the laptop clock 5 minutes behind GitHub, signs the pause time plus one second and warns (AC-077)', async () => {
    const t = setup({ clock: '2026-10-02T09:05:10Z', inbox: paused('2026-10-02T09:05:00Z') });

    const r = await t.cli(['resume']);

    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/clock/);
    expect(t.posted(INBOX).timestamp).toBe('2026-10-02T09:05:01Z');
    expect((await pauseState()).line).toBe(false);
  });

  it('resume <station> lifts only that station', async () => {
    const t = setup({
      inbox: {
        labels: ['pause:line', 'pause:build'],
        events: [
          labeled('pause:line', '2026-10-02T08:58:00Z'),
          labeled('pause:build', '2026-10-02T08:59:00Z'),
        ],
      },
    });

    expect((await t.cli(['resume', 'build'])).code).toBe(0);
    expect(t.posted(INBOX).scope).toBe('build');
    expect(t.issue(INBOX).labels).toEqual(['pause:line']);
    const state = await pauseState();
    expect(state.line).toBe(true);
    expect(state.stations.size).toBe(0);
  });

  it('resume refuses a scope that was never paused', async () => {
    const t = setup();
    const r = await t.cli(['resume']);
    expect(r.code).toBe(1);
    expect(t.issue(INBOX).comments).toEqual([]);
  });

  it('keeps the label when signing the resume fails (AC-077)', async () => {
    const t = setup({ noKey: true, inbox: paused('2026-10-02T08:59:00Z') });

    const r = await t.cli(['resume']);

    expect(r.code).toBe(1);
    expect(t.issue(INBOX).labels).toEqual(['pause:line']);
    expect(t.issue(INBOX).comments).toEqual([]);
  });
});
