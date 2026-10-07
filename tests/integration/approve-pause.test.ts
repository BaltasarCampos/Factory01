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
import { makeRepo, mergeBrief, type TestRepo } from '../helpers/git-repo.js';
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
const SPEC = `# Add login

## Problem

Visitors cannot sign in.

## Non-goals

- Social login.

## Affected areas

- \`src/auth/\`

1. **AC-001** — **Given** a registered user, **When** they sign in, **Then** they see their links.
`;
const config = (sha: string) =>
  `factory_release: v1.0.0@${sha}\nrepo: ${REPO}\ninbox_issue: 1\nagents: cloud\n`;

let owner: TestKeys;
/** An older Owner key, still listed in the release. */
let old: TestKeys;
beforeAll(() => {
  owner = makeKeys();
  old = makeKeys();
});

const labeled = (name: string, at: string) => ({
  event: 'labeled' as const,
  label: { name },
  actor: { login: 'owner' },
  created_at: at,
});

/** A comment holding a `spec-approved` record for the item, signed with `keys`. */
function specApprovedBy(keys: TestKeys, specSha: string) {
  const record: ApprovalRecord = {
    repo: REPO,
    issue: ITEM,
    gate: 'spec-approved',
    tier: 2,
    branch: BRANCH,
    spec_sha: specSha,
    timestamp: '2026-10-01T08:30:00Z',
    nonce: newNonce(),
  };
  const body = renderComment(record, sign(record, keys.privateKey, { stdinIsTTY: true }));
  return { id: 901, author: 'owner', body, createdAt: '2026-10-01T08:30:00Z' };
}

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

/** Add the item's draft PR once its head commit is known. */
function seedPr(head: string) {
  const state = readState();
  state.repos[REPO]?.prs.push({
    number: 8,
    title: '#7 Add login',
    body: '',
    author: 'owner',
    headRefName: BRANCH,
    baseRefName: 'main',
    headRefOid: head,
    isDraft: true,
    state: 'OPEN',
    comments: [],
    createdAt: '2026-10-02T08:00:00Z',
  });
  writeFileSync(process.env.FAKE_GH_STATE ?? '', JSON.stringify(state));
}

interface Setup {
  issues?: (Partial<FakeIssue> & { number: number })[];
  prs?: (Partial<FakePr> & { number: number; headRefName: string })[];
  inbox?: Partial<FakeIssue>;
  /** GitHub's clock. */
  clock?: string;
  /** Leave the Owner key out of ~/.factory/keys, so signing fails. */
  noKey?: boolean;
  /** The pinned release revokes the Owner's current key, or the older one. */
  revoke?: 'owner' | 'old';
  /** Main pins a release the factory clone does not have. */
  unknownRelease?: boolean;
  /** Main has no Owner-signed `Factory-Merge: define` yet. */
  briefUnmerged?: boolean;
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
  // The factory release pinned on main, whose key lists every check on main's side uses.
  const factory = makeRepo({
    files: {
      allowed_signers: `${old.allowedSignersLine}\n${owner.allowedSignersLine}\n`,
      revoked_keys: { owner: `${owner.publicKey}\n`, old: `${old.publicKey}\n`, none: '' }[
        options.revoke ?? 'none'
      ],
    },
  });
  const pin = options.unknownRelease ? 'a'.repeat(40) : factory.revParse('HEAD');
  const project = makeRepo({ files: { '.factory/config': config(pin) }, signWith: owner });
  if (!options.briefUnmerged) mergeBrief(project, { signWith: owner });
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
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, FACTORY_SOURCE: factory.path };
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

describe('factory approve (AC-068)', { timeout: 60_000 }, () => {
  it('approve <issue> signs gate approved with the confirmed tier, posts the record, then applies owner:approved', async () => {
    const t = setup();

    const r = await t.cli(['approve', String(ITEM)]);

    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('tier: 2');
    // The approval summary comes first, so the Owner reads it before the passphrase (AC-016).
    const parts = [
      'What changed',
      'Spec mapping',
      'Tests and review',
      'Usage spent',
      'Known risks',
    ];
    for (const part of parts) expect(r.stdout).toMatch(new RegExp(`^${part}$`, 'm'));
    expect(r.stdout.indexOf('Known risks')).toBeLessThan(r.stdout.indexOf('Signing for'));
    expect(r.stdout).toMatch(/#7: Add login/);
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

  it('approve <issue> warns while main has no Owner-signed Factory-Merge: define, and still signs (AC-006)', async () => {
    const t = setup({ briefUnmerged: true });

    const r = await t.cli(['approve', String(ITEM)]);

    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(
      /^warning: main has no Owner-signed Factory-Merge: define.*admits no item/m,
    );
    expect(t.issue(ITEM).labels).toContain('owner:approved');
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
    let commit = '';
    const t = setup({
      issues: [{ number: ITEM, title: 'Add login', ...approvedItem() }],
      project: (repo) => {
        repo.checkout(BRANCH, { create: true });
        commit = repo.commit({ 'specs/7-add-login/spec.md': SPEC }, 'spec');
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
    // Every part is read at one commit, which the summary names (AC-092).
    expect(r.stdout).toContain(`Approval summary for #7 (spec-approved) at ${commit}`);
    expect(r.stdout).toMatch(/AC-001: Given a registered user/);
  });

  it('a spec re-approval shows the diff from the last approved spec.md (AC-092)', async () => {
    const t = setup({
      issues: [{ number: ITEM, title: 'Add login', ...approvedItem() }],
      project: (repo) => {
        repo.checkout(BRANCH, { create: true });
        repo.commit({ 'specs/7-add-login/spec.md': SPEC }, 'spec');
        repo.push();
        repo.checkout('main');
      },
    });
    expect((await t.cli(['approve', String(ITEM), 'spec'])).code).toBe(0);
    t.project.checkout(BRANCH);
    const changed = SPEC.replace('Visitors cannot sign in.', 'Visitors cannot sign in or out.');
    t.project.commit({ 'specs/7-add-login/spec.md': changed }, 'spec v2');
    t.project.push();
    t.project.checkout('main');

    const r = await t.cli(['approve', String(ITEM), 'spec']);

    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/spec\.md changed since the approved blob [0-9a-f]{12}/);
    expect(r.stdout).toContain('> -Visitors cannot sign in.');
    expect(r.stdout).toContain('> +Visitors cannot sign in or out.');
  });

  it('approve <issue> spec refuses to sign while a summary part is missing (AC-016)', async () => {
    const t = setup({
      issues: [{ number: ITEM, title: 'Add login', ...approvedItem() }],
      project: (repo) => {
        repo.checkout(BRANCH, { create: true });
        repo.commit({ 'specs/7-add-login/spec.md': '# Add login\n' }, 'spec');
        repo.push();
        repo.checkout('main');
      },
    });
    const before = t.issue(ITEM).comments.length;

    const r = await t.cli(['approve', String(ITEM), 'spec']);

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Spec mapping: spec.md defines no acceptance criteria/);
    expect(r.stdout).not.toMatch(/Signing for/);
    expect(t.issue(ITEM).comments).toHaveLength(before);
    expect(t.issue(ITEM).labels).not.toContain('owner:spec-approved');
  });

  it('approve <issue> spec refuses when the item has no verified owner:approved', async () => {
    const t = setup({ issues: [{ number: ITEM, title: 'Add login', labels: ['owner:approved'] }] });
    const r = await t.cli(['approve', String(ITEM), 'spec']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/owner:approved/);
    expect(t.issue(ITEM).labels).not.toContain('owner:spec-approved');
  });

  it("a spec approval signed with a key main's release revokes never defines the last approval (AC-092)", async () => {
    const item = approvedItem();
    const t = setup({
      issues: [
        {
          number: ITEM,
          title: 'Add login',
          ...item,
          comments: [...item.comments, specApprovedBy(old, 'c'.repeat(40))],
        },
      ],
      revoke: 'old',
      project: (repo) => {
        repo.checkout(BRANCH, { create: true });
        repo.commit({ 'specs/7-add-login/spec.md': SPEC }, 'spec');
        repo.push();
        repo.checkout('main');
      },
    });

    const r = await t.cli(['approve', String(ITEM), 'spec']);

    expect(r.stderr).toBe('');
    expect(r.stdout).not.toMatch(/changed since the approved blob|is not available/);
    expect(r.stdout).toMatch(/> Problem: Visitors cannot sign in\./);
  });

  it("refuses when the item's approved record is signed with a key main's release revokes (AC-085)", async () => {
    const t = setup({
      issues: [{ number: ITEM, title: 'Add login', ...approvedItem() }],
      revoke: 'owner',
      project: (repo) => {
        repo.checkout(BRANCH, { create: true });
        repo.commit({ 'specs/7-add-login/spec.md': SPEC }, 'spec');
        repo.push();
        repo.checkout('main');
      },
    });

    const r = await t.cli(['approve', String(ITEM), 'spec']);

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/#7 has no verified owner:approved/);
    expect(t.issue(ITEM).labels).not.toContain('owner:spec-approved');
  });

  it("refuses when main's pinned key lists cannot be read (AC-084)", async () => {
    const t = setup({
      issues: [{ number: ITEM, title: 'Add login', ...approvedItem() }],
      unknownRelease: true,
    });
    const r = await t.cli(['approve', String(ITEM), 'waiver', 'gate:plan']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/factory release a{40} has no allowed_signers/);
    expect(t.issue(ITEM).labels).not.toContain('owner:waiver');
  });

  it('refuses when main cannot be fetched, so a stale pin never decides (AC-084)', async () => {
    const t = setup({
      issues: [{ number: ITEM, title: 'Add login', ...approvedItem() }],
      // origin/main is still in the clone (a stale pin), but origin cannot be fetched.
      project: (repo) => repo.git(['remote', 'set-url', 'origin', join(repo.path, 'missing.git')]),
    });
    const r = await t.cli(['approve', String(ITEM), 'waiver', 'gate:plan']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cannot fetch main/);
    expect(t.issue(ITEM).labels).not.toContain('owner:waiver');
  });

  it('a code-gate waiver refuses while the release has no such check, naming it (AC-093)', async () => {
    let head = '';
    const t = setup({
      issues: [{ number: ITEM, title: 'Add login', ...approvedItem() }],
      project: (repo) => {
        repo.checkout(BRANCH, { create: true });
        head = repo.commit({ 'src/login.ts': 'export {};\n' }, 'build');
        repo.push();
        repo.checkout('main');
      },
    });
    seedPr(head);
    const before = t.issue(ITEM).comments.length;

    const r = await t.cli(['approve', String(ITEM), 'waiver', 'gate:coverage']);

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(
      /this release has no coverage check yet, so there is nothing to waive/,
    );
    expect(t.issue(ITEM).comments).toHaveLength(before);
    expect(t.issue(ITEM).labels).not.toContain('owner:waiver');
  });

  it('a code-gate waiver refuses when the PR head is not the commit it read (AC-093)', async () => {
    const t = setup({
      issues: [{ number: ITEM, title: 'Add login', ...approvedItem() }],
      prs: [{ number: 8, headRefName: BRANCH, headRefOid: PR_HEAD, isDraft: true }],
      project: (repo) => {
        repo.checkout(BRANCH, { create: true });
        repo.commit({ 'src/login.ts': 'export {};\n' }, 'build');
        repo.push();
        repo.checkout('main');
      },
    });
    const r = await t.cli(['approve', String(ITEM), 'waiver', 'gate:coverage']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(
      /PR head 1c9d0e5f6a7b is not the commit read from origin\/claude\/7-add-login/,
    );
  });

  it('a pre-build gate waiver carries no head', async () => {
    const t = setup({ issues: [{ number: ITEM, title: 'Add login', ...approvedItem() }] });

    expect((await t.cli(['approve', String(ITEM), 'waiver', 'gate:plan'])).code).toBe(0);
    const prebuild = t.posted(ITEM);
    expect(prebuild).toMatchObject({ waives: 'gate:plan', tier: 2, branch: BRANCH });
    expect(prebuild.head).toBeUndefined();
    expect(t.issue(ITEM).labels).toContain('owner:waiver');
  });

  it('refuses test: waiver targets until that waiver form exists (AC-061, AC-093)', async () => {
    const t = setup({ issues: [{ number: ITEM, title: 'Add login', ...approvedItem() }] });
    const r = await t.cli(['approve', String(ITEM), 'waiver', 'test:tests/a.test.ts#locks out']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/test: waiver targets are not supported yet/);
    expect(t.issue(ITEM).labels).not.toContain('owner:waiver');
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

  const alert = (id: number, at: string, text: string) => ({
    id,
    author: 'owner',
    createdAt: at,
    body: `<!-- factory-alert id=01J9Z8X7W6V5T4S3R2Q1P0N${String(id)} urgency=urgent kind=tampering -->\n\n${text}\n`,
  });

  it('resume shows what was paused, when and by whom, the alerts raised during it and the items whose state changed since (AC-096)', async () => {
    const t = setup({
      inbox: {
        labels: ['pause:line'],
        events: [{ ...labeled('pause:line', '2026-10-02T08:59:00Z'), actor: { login: 'ops-bot' } }],
        comments: [
          alert(101, '2026-10-02T08:00:00Z', 'an alert from before the pause'),
          alert(102, '2026-10-02T08:59:30Z', 'a secret in the logs'),
        ],
      },
      issues: [
        {
          number: ITEM,
          title: 'Add login',
          labels: ['state:building'],
          events: [
            labeled('state:triaged', '2026-10-02T08:00:00Z'),
            labeled('state:building', '2026-10-02T08:59:40Z'),
          ],
        },
        {
          number: 8,
          title: 'Old work',
          labels: ['state:done'],
          events: [labeled('state:done', '2026-10-02T08:10:00Z')],
        },
      ],
    });

    const r = await t.cli(['resume']);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Approval summary for #1 (resume)');
    expect(r.stdout).toMatch(/pause:line added at 2026-10-02T08:59:00Z by ops-bot/);
    expect(r.stdout).toMatch(/urgent tampering: a secret in the logs/);
    expect(r.stdout).not.toMatch(/before the pause/);
    expect(r.stdout).toMatch(/#7 Add login: state:building/);
    expect(r.stdout).not.toMatch(/#8/);
    expect(r.stdout.indexOf('Known risks')).toBeLessThan(r.stdout.indexOf('Signing for'));
  });

  it('resume refuses, signing nothing, when it cannot read what changed during the pause (AC-096)', async () => {
    const t = setup({
      inbox: paused('2026-10-02T08:59:00Z'),
      issues: [
        { number: ITEM, title: 'Add login', events: [labeled('state:building', 'not a time')] },
      ],
    });

    const r = await t.cli(['resume']);

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cannot read/);
    expect(t.issue(INBOX).comments).toEqual([]);
    expect(t.issue(INBOX).labels).toEqual(['pause:line']);
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
