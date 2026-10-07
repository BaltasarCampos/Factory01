import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderComment } from '../../src/approvals/record.js';
import { sign } from '../../src/approvals/sign.js';
import { dispatchOnce, type DispatchContext } from '../../src/dispatcher/dispatch.js';
import { runStop } from '../../src/hooks/stop.js';
import { STATES, type ApprovalRecord } from '../../src/model/types.js';
import {
  BACKLOG_PATH,
  BRIEF_PATH,
  checkDefine,
  SEED_MARKER,
} from '../../src/stations/checks/define.js';
import { FakeLauncher } from '../helpers/fake-launcher.js';
import { seedState, type FakeIssue } from '../helpers/fake-gh.js';
import { makeRepo, mergeIntoMain, type Files, type TestRepo } from '../helpers/git-repo.js';
import { makeKeys, writeKeyFiles, type TestKeys } from '../helpers/keys.js';

const REPO = 'owner/project';
const DEFINE = 'claude/define';
const QUESTIONS_PATH = '.factory/define/questions.md';
const ANSWERS_PATH = '.factory/define/answers.md';
const CONFIG = `factory_release: v1.0.0@${'a'.repeat(40)}\nagents: local\nprofile: typescript\nrepo: ${REPO}\ninbox_issue: 1\n`;
const ROLE = '---\nname: define\nmodel: sonnet\ntools: Read, Write\nversion: 1\n---\nDefine.\n';
const QUESTIONS = 'Q1. Who uses it?\nQ2. Must search cover page text?\n';
const ANSWERS = 'A1. Only me.\nA2. Titles only.\n';
const BRIEF = `# Brief

## Problem
Saving links across devices is clumsy. [pitch]

## Users
The Owner, on a phone and a laptop. [answer:Q1]

## Core use cases
- Save a link with one tap. [pitch]
- Find a saved link by a word of its title. [answer:Q2]

## Non-goals
- Sharing links with other people. [answer:Q1]

## Success measures
- A link is saved in under 5 seconds. [pitch]

## Risk areas
- The existing app has no tests. [code:src/app.ts]
`;
const SKELETON: Files = {
  'package.json': '{ "scripts": { "start": "node dist/server.js", "test": "vitest run" } }\n',
  'tests/health.test.ts': "it('answers /health', () => {});\n",
};
const SEEDS = [2, 3, 4, 5, 6];
const backlog = (issues: readonly number[]) =>
  `# Backlog\n\n${issues.map((n) => `- #${String(n)} Seed ${String(n)}`).join('\n')}\n`;
const BEFORE = '2026-10-01T08:00:00Z';
const LATER = '2026-10-01T08:05:00Z';

let owner: TestKeys;
beforeAll(() => {
  owner = makeKeys();
});

interface Seed {
  number: number;
  body?: string;
  labels?: string[];
  /** Owner-signed `approved` record and its `owner:approved` label. */
  approved?: boolean;
}

function approvalComment(issue: number): FakeIssue['comments'][number] {
  const record: ApprovalRecord = {
    repo: REPO,
    issue,
    gate: 'approved',
    tier: 2,
    branch: `claude/${String(issue)}-seed`,
    timestamp: BEFORE,
    nonce: randomBytes(16).toString('hex'),
  };
  const body = renderComment(record, sign(record, owner.privateKey, { stdinIsTTY: true }));
  return { id: 5000 + issue, author: 'owner', body, createdAt: BEFORE };
}

function toIssue(seed: Seed): Partial<FakeIssue> & { number: number } {
  const labels = seed.labels ?? ['tier:2'];
  return {
    number: seed.number,
    title: `Seed ${String(seed.number)}`,
    author: 'owner',
    body: seed.body ?? `${SEED_MARKER}\nA seed issue.\n`,
    labels: seed.approved ? [...labels, 'owner:approved'] : labels,
    comments: seed.approved ? [approvalComment(seed.number)] : [],
    events: seed.approved
      ? [
          {
            event: 'labeled',
            label: { name: 'owner:approved' },
            actor: { login: 'owner' },
            created_at: LATER,
          },
        ]
      : [],
  };
}

interface ProjectOptions {
  seeds?: Seed[];
  main?: Files;
  /** The draft PR from `claude/define`; `null` for none. */
  pr?: { isDraft?: boolean; baseRefName?: string } | null;
}

/** A project with `.factory/config` on main and `claude/define` checked out and pushed. */
function project(options: ProjectOptions = {}): TestRepo {
  const files = { '.factory/config': CONFIG, '.claude/agents/define.md': ROLE };
  const repo = makeRepo({
    files: { ...files, 'src/app.ts': 'export {};\n', ...options.main },
    signWith: owner,
  });
  repo.checkout(DEFINE, { create: true });
  repo.push(DEFINE);
  const pr =
    options.pr === null ? [] : [{ number: 50, headRefName: DEFINE, isDraft: true, ...options.pr }];
  const seeds = (options.seeds ?? SEEDS.map((number) => ({ number }))).map(toIssue);
  seedState({
    repos: {
      [REPO]: {
        origin: repo.origin,
        labels: STATES.map((s) => ({ name: `state:${s}`, color: 'ededed', description: '' })),
        issues: [{ number: 1, title: 'Owner inbox' }, ...seeds],
        prs: pr,
      },
    },
  });
  return repo;
}

const ask = (r: TestRepo, text = QUESTIONS) =>
  r.commit({ [QUESTIONS_PATH]: text }, 'Define: questions');
const answer = (r: TestRepo, text = ANSWERS) =>
  r.commit({ [ANSWERS_PATH]: text }, 'Owner: answers');
const output = (r: TestRepo, files: Files = {}) =>
  r.commit(
    { [BRIEF_PATH]: BRIEF, ...SKELETON, [BACKLOG_PATH]: backlog(SEEDS), ...files },
    'Define: brief, skeleton and seed backlog',
  );

async function check(r: TestRepo) {
  r.push(DEFINE);
  return checkDefine({ workdir: r.path, repo: REPO });
}

/** A Define run with every output in place, before `edit` changes it. */
async function fullRun(options: ProjectOptions = {}, files: Files = {}) {
  const r = project(options);
  ask(r);
  answer(r);
  output(r, files);
  return check(r);
}

describe('Define output check: questions first (AC-004, AC-056)', { timeout: 60_000 }, () => {
  it('AC-004: questions asked and pushed with the draft PR open is a valid stop, waiting for the Owner', async () => {
    const r = project();
    ask(r);
    const result = await check(r);
    expect(result).toMatchObject({ complete: false, waiting: true });
  });

  it.each([
    ['no questions', 'Just a note.\n', /no questions/],
    ['six questions', 'Q1. a\nQ2. b\nQ3. c\nQ4. d\nQ5. e\nQ6. f\n', /6 questions; ask 1–5/],
    ['a gap in the numbering', 'Q1. a\nQ3. b\n', /numbered Q1/],
  ])('AC-004: refuses %s', async (_name, text, why) => {
    const r = project();
    ask(r, text);
    const result = await check(r);
    expect(result.complete).toBe(false);
    expect(result.waiting).toBe(false);
    expect(result.missing?.join('\n')).toMatch(why);
  });

  it('AC-004: questions changed in a second commit are not one batch', async () => {
    const r = project();
    ask(r, 'Q1. Who uses it?\n');
    ask(r);
    const result = await check(r);
    expect(result.missing?.join('\n')).toMatch(/2 commits; ask in one batch/);
  });

  it('AC-004: questions left on main by an earlier run do not count as asked in this run', async () => {
    const r = project({ main: { [QUESTIONS_PATH]: QUESTIONS, [ANSWERS_PATH]: ANSWERS } });
    output(r);
    const result = await check(r);
    expect(result.missing?.join('\n')).toMatch(/not asked in this run/);
  });

  it('AC-056: a gap-free pitch still gets one confirming question, and no brief before its answer', async () => {
    const r = project();
    ask(r, 'Q1. The pitch seems complete: is anything missing?\n');
    output(r, { [BRIEF_PATH]: BRIEF.replace(/\[answer:Q\d\]/g, '[pitch]') });
    const result = await check(r);
    expect(result).toMatchObject({ complete: false, waiting: false });
    expect(result.missing?.join('\n')).toMatch(/before the Owner's answers/);
  });

  it('AC-056: every question needs an answer', async () => {
    const r = project();
    ask(r);
    answer(r, 'A1. Only me.\n');
    output(r);
    const result = await check(r);
    expect(result.missing).toContain(`${ANSWERS_PATH}: no answer to Q2`);
  });

  it('AC-063: the stop hook lets Define stop while it waits for answers, and not with a brief written first', async () => {
    const r = project();
    ask(r);
    r.push(DEFINE);
    const input = { agent_type: 'define', session_id: 's1', hook_event_name: 'Stop' };
    const ctx = { cwd: r.path, now: () => new Date() };
    expect(await runStop(input, ctx)).toEqual({ block: false });
    output(r);
    r.push(DEFINE);
    expect(await runStop(input, ctx)).toEqual({
      block: true,
      reason: expect.stringMatching(/before the Owner's answers/) as string,
    });
  });
});

describe(
  'Define output check: brief, skeleton, backlog (AC-004, AC-005)',
  { timeout: 60_000 },
  () => {
    it('AC-005: a complete Define run passes', async () => {
      expect(await fullRun()).toEqual({ complete: true, waiting: false, missing: [] });
    });

    it('AC-004: every brief statement carries a source tag that names something real', async () => {
      const brief = BRIEF.replace('one tap. [pitch]', 'one tap.')
        .replace('[answer:Q2]', '[answer:Q9]')
        .replace('[code:src/app.ts]', '[code:src/missing.ts]');
      const result = await fullRun({}, { [BRIEF_PATH]: brief });
      expect(result.complete).toBe(false);
      expect(result.missing).toEqual(
        expect.arrayContaining([
          `${BRIEF_PATH}:10: no source tag`,
          `${BRIEF_PATH}:11: [answer:Q9] names no question`,
          `${BRIEF_PATH}:20: [code:src/missing.ts] is not in the tree`,
        ]),
      );
    });

    it('AC-005: the brief has every section', async () => {
      const result = await fullRun(
        {},
        { [BRIEF_PATH]: BRIEF.replace('## Risk areas', '## Risks') },
      );
      expect(result.missing).toContain(`${BRIEF_PATH}: no section "Risk areas"`);
    });

    it('AC-005: the skeleton has a test script and a test', async () => {
      const files = { 'package.json': '{ "scripts": {} }\n', 'tests/health.test.ts': null };
      const result = await fullRun({}, files);
      expect(result.missing).toEqual(
        expect.arrayContaining([
          'skeleton: package.json has no test script',
          'skeleton: no tests/**/*.test.ts',
        ]),
      );
    });

    it.each([
      ['4 seed issues', [2, 3, 4, 5], /4 new seed issues; Define files 5–10/],
      ['11 seed issues', [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], /11 new seed issues/],
    ])('AC-005: refuses %s', async (_name, issues, why) => {
      const seeds = issues.map((number) => ({ number }));
      const result = await fullRun({ seeds }, { [BACKLOG_PATH]: backlog(issues) });
      expect(result.missing?.join('\n')).toMatch(why);
    });

    it('AC-005: each seed issue is open, marked as a seed and has exactly one tier: label', async () => {
      const seeds = [
        { number: 2, labels: ['tier:1', 'tier:2'] },
        { number: 3, labels: [] },
        { number: 4, body: 'No marker.\n' },
        { number: 5 },
        { number: 6 },
      ];
      const result = await fullRun({ seeds });
      expect(result.missing).toEqual([
        '#2: 2 tier: labels; exactly one',
        '#3: 0 tier: labels; exactly one',
        `#4: no ${SEED_MARKER} marker`,
      ]);
    });
  },
);

describe(
  'Define output check: claude/define and its draft PR (AC-006)',
  { timeout: 60_000 },
  () => {
    it('AC-006: output on any branch but claude/define is refused', async () => {
      const r = project();
      ask(r);
      answer(r);
      r.checkout('claude/other', { create: true });
      output(r);
      const result = await checkDefine({ workdir: r.path, repo: REPO });
      expect(result.missing).toContain('not on claude/define (on claude/other)');
    });

    it('AC-006: needs exactly one open draft PR from claude/define to main, at the checked commit', async () => {
      expect((await fullRun({ pr: null })).missing).toContain(
        'pull request: none open from claude/define',
      );
      expect((await fullRun({ pr: { isDraft: false } })).missing).toContain(
        'pull request #50 is not a draft',
      );
      expect((await fullRun({ pr: { baseRefName: 'dev' } })).missing).toContain(
        'pull request #50 targets dev, not main',
      );
      const r = project();
      ask(r);
      answer(r);
      r.push(DEFINE);
      output(r);
      const unpushed = await checkDefine({ workdir: r.path, repo: REPO });
      expect(unpushed.missing?.join('\n')).toMatch(
        /pull request #50 is at [0-9a-f]{40}, not the checked/,
      );
    });

    it('AC-064: a re-run keeps every seed issue already on main and files 5–10 new ones', async () => {
      const main = { [BACKLOG_PATH]: backlog(SEEDS) };
      const all = [...SEEDS, 7, 8, 9, 10, 11];
      const seeds = all.map((number) => ({ number }));
      const dropped = await fullRun({ main, seeds }, { [BACKLOG_PATH]: backlog(all.slice(1)) });
      expect(dropped.missing).toEqual(['backlog: drops seed issue #2 listed on main']);
      expect(await fullRun({ main, seeds }, { [BACKLOG_PATH]: backlog(all) })).toMatchObject({
        complete: true,
      });
    });
  },
);

describe('dispatcher waits for the Define merge (AC-006, AC-064)', { timeout: 60_000 }, () => {
  function dispatcher(r: TestRepo) {
    const local = new FakeLauncher('local');
    const keys = writeKeyFiles([owner]);
    const ctx: DispatchContext = {
      projectDir: r.path,
      keysFor: () => keys,
      secondCopy: owner.publicKey,
      historySigned: () => Promise.resolve(true),
      gatherEvidence: () => Promise.resolve({ needsSession: true, intakeComplete: true }),
      launchers: { local, cloud: new FakeLauncher('cloud') },
      logEvent: () => Promise.resolve(),
    };
    return { ctx, local };
  }

  /** The Owner's signed `git merge --no-ff -S` of claude/define into main. */
  const ownerMerge = (r: TestRepo) => mergeIntoMain(r, DEFINE, 'define', { signWith: owner });

  it('AC-006: no seed issue is picked before the Owner merges the Define PR, approved or not', async () => {
    const seeds = [
      { number: 2, approved: true },
      { number: 3, approved: true, body: 'Marker removed.\n' },
    ];
    const r = project({ seeds });
    ask(r);
    answer(r);
    output(r, { [BACKLOG_PATH]: backlog([2, 3]) });
    r.push(DEFINE);
    const { ctx, local } = dispatcher(r);

    const result = await dispatchOnce(ctx);

    expect(result.skipped).toEqual([
      { issue: 2, reason: expect.stringMatching(/merge the Define pull request/) as string },
      { issue: 3, reason: expect.stringMatching(/merge the Define pull request/) as string },
    ]);
    expect(result.moves).toEqual([]);
    expect(local.launches).toEqual([]);
  });

  it('AC-006: after the Owner-signed merge, approved seed issues enter the line and unapproved ones wait', async () => {
    const r = project({ seeds: [{ number: 2, approved: true }, { number: 3 }] });
    ask(r);
    answer(r);
    output(r, { [BACKLOG_PATH]: backlog([2, 3]) });
    r.push(DEFINE);
    ownerMerge(r);
    const { ctx, local } = dispatcher(r);

    const result = await dispatchOnce(ctx);

    expect(result.skipped).toEqual([
      { issue: 3, reason: expect.stringMatching(/no verified owner:approved/) as string },
    ]);
    expect(result.moves).toEqual([
      expect.objectContaining({ issue: 2, from: 'new', to: 'triaged' }),
    ]);
    expect(local.launches).toEqual([expect.objectContaining({ item: 2, branch: 'claude/2-seed' })]);
  });

  it("AC-064: once a brief is merged, a re-run's new seed issues wait for their own owner:approved", async () => {
    const seeds = [{ number: 2, approved: true }, { number: 7 }];
    const r = project({ seeds });
    ask(r);
    answer(r);
    output(r, { [BACKLOG_PATH]: backlog([2]) });
    ownerMerge(r);
    r.checkout(DEFINE);
    r.commit({ [BACKLOG_PATH]: backlog([2, 7]) }, 'Define: re-run backlog');
    r.push(DEFINE);
    const { ctx, local } = dispatcher(r);

    const result = await dispatchOnce(ctx);

    expect(result.skipped).toEqual([
      { issue: 7, reason: expect.stringMatching(/no verified owner:approved/) as string },
    ]);
    expect(local.launches).toEqual([expect.objectContaining({ item: 2 })]);
  });
});
