import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderComment } from '../../src/approvals/record.js';
import { sign } from '../../src/approvals/sign.js';
import { createItemBranch } from '../../src/dispatcher/branch.js';
import {
  changedFiles,
  dispatchOnce,
  ownerAnswers,
  type DispatchContext,
} from '../../src/dispatcher/dispatch.js';
import { gatherEvidence } from '../../src/dispatcher/evidence.js';
import { nextTask, writeStationManifest } from '../../src/dispatcher/manifest.js';
import { configOnMain } from '../../src/model/config.js';
import { parseAlert } from '../../src/notify/inbox.js';
import { STATES, STATIONS, type ApprovalRecord, type Tier } from '../../src/model/types.js';
import { FakeClock } from '../helpers/fake-clock.js';
import { FakeLauncher } from '../helpers/fake-launcher.js';
import { readState, seedState, type FakeComment, type FakeIssue } from '../helpers/fake-gh.js';
import {
  makeRepo,
  mergeBrief,
  mergeIntoMain,
  type Files,
  type TestRepo,
} from '../helpers/git-repo.js';
import { makeKeys, makeOtherKeys, writeKeyFiles, type TestKeys } from '../helpers/keys.js';
import { testPrompts } from '../helpers/release.js';

const REPO = 'owner/project';
const INBOX = 1;
const ISSUE = 2;
const BRANCH = 'claude/2-add-login';
const FEATURE = 'specs/2-add-login';
const PIN = `v1.0.0@${'a'.repeat(40)}`;
const BEFORE = '2026-10-01T08:00:00Z';
const LABELS = [
  ...STATES.map((s) => `state:${s}`),
  ...['owner:approved', 'owner:spec-approved', 'owner:waiver', 'pause:line'],
  ...STATIONS.map((s) => `pause:${s}`),
  ...['type:feature', 'priority:p2', 'tier:1', 'tier:2', 'tier:3'],
].map((name) => ({ name, color: 'ededed', description: '' }));
const INTAKE_LABELS = ['type:feature', 'priority:p2', 'tier:2'];

let owner: TestKeys;
beforeAll(() => {
  owner = makeKeys();
});

const labeled = (name: string) => ({
  event: 'labeled' as const,
  label: { name },
  actor: { login: 'owner' },
  created_at: BEFORE,
});

function approvalBody(tier: Tier): string {
  const record: ApprovalRecord = {
    ...{ repo: REPO, issue: ISSUE, gate: 'approved', tier, branch: BRANCH },
    ...{ timestamp: BEFORE, nonce: randomBytes(16).toString('hex') },
  };
  return renderComment(record, sign(record, owner.privateKey, { stdinIsTTY: true }));
}

/** An Intake event as the session would post it; `ts` is the session's claim. */
const intakeEvent = (fields: Record<string, unknown> = {}) => ({
  ts: '1999-01-01T00:00:00Z',
  ...{ item: ISSUE, station: 1, role: 'intake', role_version: 'v1.0.0+0123456789ab' },
  ...{ session: 'intake-1', model: 'claude-sonnet-5-5', kind: 'tool_call', tool: 'gh' },
  ...fields,
});
const block = (body: string) => '```factory-event\n' + body + '\n```';
const eventComment = (...events: unknown[]) =>
  events.map((e) => block(JSON.stringify(e))).join('\n\n');

interface Setup {
  /** Extra comments on the item, after the approval record. */
  comments?: Pick<FakeComment, 'body' | 'createdAt'>[];
  states?: string[];
  labels?: string[];
  tier?: Tier;
  /** Push an item branch with these files before the pass (a fixture, not the dispatcher). */
  branch?: Record<string, string>;
  /** The release pin in main's config. */
  pin?: string;
}

function setup(options: Setup = {}) {
  const config = `factory_release: ${options.pin ?? PIN}\nrepo: ${REPO}\ninbox_issue: ${String(INBOX)}\n`;
  const project = makeRepo({
    files: { '.factory/config': `${config}agents: local\n` },
    signWith: owner,
  });
  mergeBrief(project, { signWith: owner });
  if (options.branch !== undefined) {
    project.checkout(BRANCH, { create: true });
    project.commit(options.branch, 'Specify and plan');
    project.push(BRANCH);
    project.checkout('main');
  }
  const states = options.states ?? [];
  const comments: FakeComment[] = [
    { id: 5000, author: 'owner', body: approvalBody(options.tier ?? 2), createdAt: BEFORE },
    ...(options.comments ?? []).map((c, i) => ({ id: 5001 + i, author: 'owner', ...c })),
  ];
  seedState({
    clock: '2026-10-01T09:00:00Z',
    repos: {
      [REPO]: {
        origin: project.origin,
        labels: LABELS,
        issues: [
          { number: INBOX, title: 'Owner inbox' },
          {
            number: ISSUE,
            title: 'A title the slug is not derived from',
            labels: [...states, ...(options.labels ?? INTAKE_LABELS), 'owner:approved'],
            events: [...states, 'owner:approved'].map(labeled),
            comments,
          },
        ],
      },
    },
  });
  const keys = writeKeyFiles([owner], []);
  const local = new FakeLauncher('local');
  const clock = new FakeClock('2026-10-01T10:00:00Z');
  const ctx: DispatchContext = {
    projectDir: project.path,
    keysFor: () => keys,
    secondCopy: owner.publicKey,
    auditHistory: () => Promise.resolve({ recreated: [] }),
    gatherEvidence: gatherEvidence({ projectDir: project.path }),
    launchers: { local, cloud: new FakeLauncher('cloud') },
    stationPrompt: testPrompts,
    logEvent: () => Promise.resolve(),
    now: () => clock.now(),
  };
  const repoState = () => readState().repos[REPO] ?? { issues: [], prs: [] };
  return {
    ctx,
    project,
    local,
    labels: () => repoState().issues.find((i) => i.number === ISSUE)?.labels ?? [],
    inbox: () => repoState().issues.find((i) => i.number === INBOX)?.comments ?? [],
    prs: () => repoState().prs,
    /** A file on the item branch as origin has it. */
    show: (path: string) => show(project, `origin/${BRANCH}`, path),
  };
}

function show(project: TestRepo, ref: string, path: string): string {
  project.git(['fetch', '-q', 'origin']);
  return project.git(['show', `${ref}:${path}`]);
}

const seededLines = (t: ReturnType<typeof setup>) =>
  t
    .show(`${FEATURE}/events.jsonl`)
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

/** Add a canned `ci / red-green` check run for a commit to the fake GitHub. */
function checkRun(
  sha: string,
  conclusion: 'success' | 'failure' | null,
  run: { status?: string; app?: string } = {},
) {
  const state = readState();
  const repo = state.repos[REPO];
  if (repo === undefined) throw new Error('no repo');
  const { status = 'completed', app = 'github-actions' } = run;
  repo.api[`repos/${REPO}/commits/${sha}/check-runs`] = {
    total_count: 1,
    check_runs: [{ name: 'red-green', head_sha: sha, status, conclusion, app: { slug: app } }],
  };
  seedState(state, process.env.FAKE_GH_STATE);
}

/** Change the fake GitHub's state in place. */
function editState(
  edit: (repo: NonNullable<ReturnType<typeof readState>['repos'][string]>) => void,
) {
  const state = readState();
  const repo = state.repos[REPO];
  if (repo === undefined) throw new Error('no repo');
  edit(repo);
  seedState(state, process.env.FAKE_GH_STATE);
}

describe('work-item branch creation (AC-066, FR-016a)', { timeout: 60_000 }, () => {
  it('on new → triaged the dispatcher creates the branch named by the approved record, committing no .specify/feature.json (AC-066, T170)', async () => {
    const t = setup();

    const result = await dispatchOnce(t.ctx);

    expect(result.moves).toEqual([expect.objectContaining({ from: 'new', to: 'triaged' })]);
    const created = ['diff-tree', '--no-commit-id', '--name-only', '-r', `origin/${BRANCH}~1`];
    expect(t.project.git(created)).toBe(`${FEATURE}/events.jsonl`);
    const message = t.project.git(['log', '-1', '--format=%B', `origin/${BRANCH}~1`]);
    expect(message).toMatch(/Factory-Role: dispatcher\nFactory-Item: 2-add-login/);
    expect(t.project.git(['rev-parse', `origin/${BRANCH}~2`])).toBe(t.project.revParse('main'));
    expect(t.local.launches).toEqual([
      expect.objectContaining({ role: 'spec', station: 2, branch: BRANCH }),
    ]);
  });

  it('copies a valid Intake factory-event block as the first line of events.jsonl, with GitHub’s comment time and cleaned text (AC-066)', async () => {
    const at = '2026-10-01T08:30:00Z';
    const body = eventComment(intakeEvent({ input_summary: 'triage ‮labels\u0007 done' }));
    const t = setup({ comments: [{ body, createdAt: at }] });

    await dispatchOnce(t.ctx);

    const lines = seededLines(t);
    expect(lines).toEqual([expect.objectContaining({ ts: at, role: 'intake', item: ISSUE })]);
    expect(lines[0]?.input_summary).toBe('triage labels done');
  });

  // Bodies are built per test: the Owner key exists only once beforeAll has run.
  it.each([
    ['a block with another role', () => eventComment(intakeEvent({ role: 'builder' }))],
    ['a block for another item', () => eventComment(intakeEvent({ item: 3 }))],
    ['a malformed block', () => block('{"item": 2, "role": "intake"')],
    ['a block that fails the Event schema', () => eventComment(intakeEvent({ kind: 'merge' }))],
    ['an oversized block', () => eventComment(intakeEvent({ input_summary: 'x'.repeat(5000) }))],
    [
      'a comment with more blocks than the cap',
      () => eventComment(...Array.from({ length: 5 }, () => intakeEvent())),
    ],
    ['a signed record comment', () => `${approvalBody(2)}\n\n${eventComment(intakeEvent())}`],
  ])('does not copy %s (AC-066)', async (_name, body) => {
    const t = setup({ comments: [{ body: body(), createdAt: '2026-10-01T08:30:00Z' }] });

    await dispatchOnce(t.ctx);

    expect(seededLines(t)).toEqual([]);
  });

  it('a later pass, with the branch already there, copies nothing new (AC-066)', async () => {
    const first = eventComment(intakeEvent({ session: 'first' }));
    const t = setup({ comments: [{ body: first, createdAt: '2026-10-01T08:30:00Z' }] });
    await dispatchOnce(t.ctx);
    const head = t.project.git(['rev-parse', `origin/${BRANCH}`]);

    const later = eventComment(intakeEvent({ session: 'later' }));
    const comments = [
      { id: '5001', author: 'owner', body: first, createdAt: '2026-10-01T08:30:00Z' },
      { id: '6000', author: 'owner', body: later, createdAt: '2026-10-01T09:30:00Z' },
    ];
    const created = createItemBranch(
      { projectDir: t.project.path, now: () => new Date('2026-10-01T10:00:00Z') },
      { issue: ISSUE, branch: BRANCH },
      comments,
    );

    expect(created).toBe(false);
    expect(t.project.git(['rev-parse', `origin/${BRANCH}`])).toBe(head);
    expect(seededLines(t).map((l) => l.session)).toEqual(['first']);
  });

  it('opens exactly one draft PR before the Specify launch, and a second pass opens none (FR-016a)', async () => {
    const t = setup();

    await dispatchOnce(t.ctx);
    await dispatchOnce(t.ctx);

    expect(t.prs()).toEqual([
      expect.objectContaining({
        headRefName: BRANCH,
        isDraft: true,
        title: '#2 A title the slug is not derived from',
      }),
    ]);
    expect(t.prs()[0]?.body).toContain('#2');
    // The second pass sees the Specify session's manifest on the branch tip: nothing pushed yet.
    expect(t.local.launches).toHaveLength(1);
  });

  it('writes .station.json before the session and names the branch in the prompt (stations 2–6)', async () => {
    const t = setup();

    await dispatchOnce(t.ctx);

    expect(JSON.parse(t.show(`${FEATURE}/.station.json`))).toEqual({
      item: ISSUE,
      station: 2,
      role: 'spec',
      branch: BRANCH,
      issued_at: '2026-10-01T10:00:00.000Z',
    });
    const prompt = t.local.launches[0]?.prompt ?? '';
    expect(prompt).toContain(`Feature folder: ${FEATURE}/ on the branch \`${BRANCH}\``);
    // The prompt carries speckit-specify's steps (T072): no command is left for the session.
    expect(prompt).toContain('## Step 1: speckit-specify');
    expect(prompt).not.toMatch(/\/speckit-/);
  });

  it('station 5’s prompt gets the files the pull request changes, against the merge base (T072)', () => {
    const t = setup({
      branch: { [`${FEATURE}/spec.md`]: '# Spec\n', 'src/login.ts': 'export {};\n' },
    });
    t.project.git(['fetch', '-q', 'origin']);

    const at = { projectDir: t.project.path, now: () => new Date() };
    expect(changedFiles(at, 'origin/main', BRANCH)).toEqual([`${FEATURE}/spec.md`, 'src/login.ts']);
  });

  it('gives the Builder its next task and that task’s file list in .station.json', () => {
    const tasks = [
      '## Phase 1',
      '### Tests',
      '- [X] T001 Login tests (AC-001) · Files: tests/login.test.ts',
      '### Implementation',
      '- [ ] T002 Login form · Files: src/login.ts, src/form.ts (shared with T003)',
      '',
    ].join('\n');
    const t = setup({ branch: { [`${FEATURE}/tasks.md`]: tasks } });

    writeStationManifest(
      { projectDir: t.project.path, now: () => new Date('2026-10-01T11:00:00Z') },
      { issue: ISSUE, branch: BRANCH },
      { station: 4, role: 'builder' },
    );

    expect(JSON.parse(t.show(`${FEATURE}/.station.json`))).toEqual({
      ...{ item: ISSUE, station: 4, role: 'builder', branch: BRANCH, task: 'T002' },
      ...{ files: ['src/login.ts', 'src/form.ts'], issued_at: '2026-10-01T11:00:00.000Z' },
    });
  });
});

describe('Intake before triage (AC-009)', { timeout: 60_000 }, () => {
  it('an approved item whose Intake output is incomplete stays new, with an Intake session on main and no branch', async () => {
    const t = setup({ labels: ['tier:2'] });

    const result = await dispatchOnce(t.ctx);

    expect(result.moves).toEqual([]);
    expect(t.labels()).not.toContain('state:triaged');
    expect(t.local.launches).toEqual([
      expect.objectContaining({ role: 'intake', station: 1, branch: 'main', item: ISSUE }),
    ]);
    expect(t.project.git(['ls-remote', '--heads', 'origin', BRANCH])).toBe('');
  });
});

describe('Intake duplicates (AC-009, slice 24a-2)', { timeout: 60_000 }, () => {
  const ORIGINAL = 9;
  const AT = '2026-10-01T08:30:00Z';
  const mark = (n = ORIGINAL) => ({
    body: `Same as #${String(n)}.\n<!-- duplicate-of #${String(n)} -->`,
    createdAt: AT,
  });
  /** The issue the marker names; Intake's check requires it to exist. */
  const original = () => {
    editState((repo) =>
      repo.issues.push({
        ...{ number: ORIGINAL, title: 'The original', body: '', author: 'owner', state: 'OPEN' },
        ...{ labels: [], comments: [], events: [], isPinned: false, createdAt: BEFORE },
      }),
    );
  };
  /** The duplicate alerts on the inbox, as their text. */
  const alerts = (t: ReturnType<typeof setup>) =>
    t.inbox().flatMap((c) => {
      const a = parseAlert({ ...c, id: String(c.id) });
      return a?.kind === 'duplicate' ? [a.text] : [];
    });
  const text = (comment: number) =>
    `#${String(ISSUE)} is marked a duplicate of #${String(ORIGINAL)} (comment ${String(comment)}): close #${String(ISSUE)}, or delete the marker if it is not a duplicate`;
  /** Changes the item in the fake GitHub's state. */
  const editItem = (edit: (item: FakeIssue) => void) => {
    editState((repo) => {
      const found = repo.issues.find((i) => i.number === ISSUE);
      if (found === undefined) throw new Error('no item');
      edit(found);
    });
  };

  it('an open item Intake marked a duplicate stays in new with no labels, starts no session and alerts the Owner once, naming the first marker', async () => {
    const t = setup({ labels: [], comments: [mark(), mark()] });
    original();

    const first = await dispatchOnce(t.ctx);
    const second = await dispatchOnce(t.ctx);

    expect([...first.moves, ...second.moves]).toEqual([]);
    expect(t.labels()).toEqual(['owner:approved']);
    expect(t.local.launches).toEqual([]);
    expect(alerts(t)).toEqual([text(5001)]);
  });

  it('with the marker deleted Intake runs again on the next pass; marked again, the item gets a new alert', async () => {
    const t = setup({ labels: [], comments: [mark()] });
    original();
    await dispatchOnce(t.ctx);
    editItem((i) => {
      i.comments = i.comments.filter((c) => !c.body.includes('duplicate-of'));
    });

    await dispatchOnce(t.ctx);

    expect(t.local.launches).toEqual([
      expect.objectContaining({ role: 'intake', station: 1, branch: 'main', item: ISSUE }),
    ]);
    editItem((i) => i.comments.push({ id: 9001, author: 'owner', ...mark() }));

    const again = await dispatchOnce(t.ctx);

    expect(again.moves).toEqual([]);
    expect(t.local.launches).toHaveLength(1);
    expect(alerts(t)).toEqual([text(5001), text(9001)]);
  });

  it('a closed marked item drops out of the line: no move, no session, no further alert', async () => {
    const t = setup({ labels: [], comments: [mark()] });
    original();
    await dispatchOnce(t.ctx);
    editItem((i) => {
      i.state = 'CLOSED';
    });

    const result = await dispatchOnce(t.ctx);

    expect(result.moves).toEqual([]);
    expect(t.local.launches).toEqual([]);
    expect(alerts(t)).toEqual([text(5001)]);
  });

  it('a marker on an item past new changes nothing: a triaged item gets its Specify session and no alert', async () => {
    const t = setup({ states: ['state:triaged'], comments: [mark()] });
    original();

    const result = await dispatchOnce(t.ctx);

    expect(result.moves).toEqual([]);
    expect(t.local.launches).toEqual([
      expect.objectContaining({ role: 'spec', station: 2, branch: BRANCH }),
    ]);
    expect(alerts(t)).toEqual([]);
  });
});

describe('building → verifying (AC-012)', { timeout: 60_000 }, () => {
  const done = [
    '## Phase 1',
    '### Tests',
    '- [X] T001 Login tests (AC-001) · Files: tests/login.test.ts',
    '### Implementation',
    '- [X] T002 Login form · Files: src/login.ts',
    '',
  ].join('\n');
  // Forged telemetry: a session claiming red-green passed.
  const forged = JSON.stringify(
    intakeEvent({
      station: 4,
      role: 'builder',
      kind: 'gate_result',
      gate: 'red-green',
      pass: true,
    }),
  );
  const building = () =>
    setup({
      tier: 1,
      states: ['state:building'],
      branch: {
        [`${FEATURE}/tasks.md`]: done,
        [`${FEATURE}/events.jsonl`]: `${forged}\n`,
      },
    });
  const head = (t: ReturnType<typeof setup>) => t.project.git(['rev-parse', `origin/${BRANCH}`]);
  const openPr = (t: ReturnType<typeof setup>) => {
    const state = readState();
    state.repos[REPO]?.prs.push({
      ...{ number: 9, title: '#2', body: '', author: 'owner', headRefName: BRANCH },
      ...{ baseRefName: 'main', headRefOid: head(t), isDraft: true, state: 'OPEN' },
      ...{ comments: [], createdAt: BEFORE },
    });
    seedState(state, process.env.FAKE_GH_STATE);
  };

  it('forged red/green gate_result events alone never move the item (AC-012)', async () => {
    const t = building();
    openPr(t);

    const result = await dispatchOnce(t.ctx);

    expect(result.moves).toEqual([]);
    expect(t.labels()).toContain('state:building');
  });

  it('a green ci / red-green on the branch head without a PR does not move it (AC-012)', async () => {
    const t = building();
    checkRun(head(t), 'success');

    expect((await dispatchOnce(t.ctx)).moves).toEqual([]);
  });

  it('moves on a green ci / red-green for the branch head of the item’s PR, and not on a red one (AC-012)', async () => {
    const t = building();
    openPr(t);
    checkRun(head(t), 'failure');
    expect((await dispatchOnce(t.ctx)).moves).toEqual([]);

    checkRun(head(t), 'success');
    const result = await dispatchOnce(t.ctx);

    expect(result.moves).toEqual([expect.objectContaining({ from: 'building', to: 'verifying' })]);
  });

  it('a green result for an older head does not count once the branch moved (AC-012)', async () => {
    const t = building();
    openPr(t);
    const old = head(t);
    checkRun(old, 'success');
    t.project.checkout(BRANCH);
    t.project.commit({ 'src/login.ts': 'export {};\n' }, 'more work');
    t.project.push(BRANCH);
    t.project.checkout('main');

    expect((await dispatchOnce(t.ctx)).moves).toEqual([]);
  });
});

const SPEC = [
  '# Add login',
  '## Problem',
  'Visitors cannot sign in.',
  '## Non-goals',
  '- Social login.',
  '## Affected areas',
  '- src/login.ts',
  '### Acceptance Scenarios',
  '1. **AC-001** Given a visitor, When they sign in, Then they see the home page.',
  '',
].join('\n');
/** The branch as the dispatcher creates it, with no Intake events. */
const CREATED = { [`${FEATURE}/events.jsonl`]: '' };
/** A branch at Verify with no new events, so the path-filtered `append-only` job is not required. */
const SPECIFIED = { [`${FEATURE}/spec.md`]: SPEC };

describe('station evidence (T060)', { timeout: 60_000 }, () => {
  type State = Parameters<ReturnType<typeof gatherEvidence>>[0]['state'];
  /** T060's evidence for the item in `state`, read the way the dispatcher reads it. */
  const gather = (
    t: ReturnType<typeof setup>,
    state: State,
    over: {
      merged?: boolean;
      branch?: string | null;
      tier?: Tier | null;
      factory?: { path: string; sha: string };
    } = {},
  ) => {
    const issue = { number: ISSUE, title: 'Add login', author: 'owner', body: '', labels: [] };
    const branch = over.branch === undefined ? BRANCH : over.branch;
    const tier = over.tier === undefined ? 2 : over.tier;
    const item = {
      issue,
      state,
      ...(branch === null ? {} : { branch }),
      ...(tier === null ? {} : { tier }),
    };
    const main = t.project.revParse('main');
    const merges = over.merged ? [{ commit: main, value: '#2' }] : [];
    // The merge commit, with its parents, as the signed-history walk lists it.
    const parents = t.project.git(['rev-list', '--parents', '-n', '1', main]).split(' ').slice(1);
    const commits = over.merged ? [{ commit: main, parents }] : [];
    const onMain = configOnMain(t.project.path);
    const pin = { ...onMain.factory_release, ...(over.factory ? { sha: over.factory.sha } : {}) };
    const config = { ...onMain, factory_release: pin };
    const factory = over.factory === undefined ? {} : { factory: over.factory.path };
    return gatherEvidence({ projectDir: t.project.path, ...factory })(
      item,
      config,
      { lastVerified: undefined, merges, commits },
      writeKeyFiles([owner]),
    );
  };
  const tipOf = (t: ReturnType<typeof setup>) => t.project.git(['rev-parse', `origin/${BRANCH}`]);

  it('reads a merged item from main once its branch is deleted', async () => {
    const t = setup({ branch: { ...CREATED, [`${FEATURE}/spec.md`]: SPEC } });
    mergeIntoMain(t.project, BRANCH, '#2', { signWith: owner });
    t.project.git(['push', '-q', 'origin', '--delete', BRANCH]);

    const e = await gather(t, 'integrating', { merged: true });

    expect(e).toMatchObject({ ownerMerge: true, specComplete: true, draftPr: false });
    expect(e.specSha).toMatch(/^[0-9a-f]{40}$/);
    expect(e.branchHead).toBeUndefined();
  });

  it('without the branch and without a merge, the station needs a session to create it', async () => {
    const t = setup();
    expect(await gather(t, 'triaged')).toEqual({ ownerMerge: false, needsSession: true });
    expect(await gather(t, 'triaged', { branch: null })).toEqual({ ownerMerge: false });
    expect(await gather(t, 'new', { tier: null })).toEqual({ ownerMerge: false });
  });

  it.each([
    ['spec.md', { [`${FEATURE}/plan.md`]: '# Plan\n', [`${FEATURE}/tasks.md`]: '- [X] T001 a\n' }],
    ['plan.md', { [`${FEATURE}/spec.md`]: SPEC, [`${FEATURE}/tasks.md`]: '- [X] T001 a\n' }],
    ['tasks.md', { [`${FEATURE}/spec.md`]: SPEC, [`${FEATURE}/plan.md`]: '# Plan\n' }],
  ])('with %s missing the plan is not complete', async (missing, files) => {
    const t = setup({ branch: { ...CREATED, ...files } });

    const e = await gather(t, 'spec-approved');

    expect(e).toMatchObject({ planComplete: false, needsSession: true });
    expect(e.specComplete).toBe(missing !== 'spec.md');
    expect(e.tasksDone).toBe(missing !== 'tasks.md');
    expect('specSha' in e).toBe(missing !== 'spec.md');
  });

  it('counts no red-green run when the open PR’s head is not the branch tip', async () => {
    const t = setup({ branch: CREATED });
    checkRun(tipOf(t), 'success');
    editState((repo) => {
      // Without the remote the fake GitHub keeps the PR head it was given: an older commit.
      delete repo.origin;
      repo.prs.push({
        ...{ number: 9, title: '#2', body: '', author: 'owner', headRefName: BRANCH },
        ...{ baseRefName: 'main', headRefOid: 'f'.repeat(40), isDraft: true, state: 'OPEN' },
        ...{ comments: [], createdAt: BEFORE },
      });
    });

    const e = await gather(t, 'building');

    expect(e).toMatchObject({ draftPr: true, branchHead: tipOf(t) });
    expect(e.redGreen).toBeUndefined();
  });

  it.each([
    ['a run still in progress', null, { status: 'in_progress' }, undefined],
    ['a run from another app', 'success', { app: 'some-ci-bot' }, undefined],
    ['a failed run', 'failure', {}, false],
    ['a passing run', 'success', {}, true],
  ] as const)('reads %s on the PR head', async (_name, conclusion, run, green) => {
    const t = setup({ branch: CREATED });
    editState((repo) => {
      repo.prs.push({
        ...{ number: 9, title: '#2', body: '', author: 'owner', headRefName: BRANCH },
        ...{ baseRefName: 'main', headRefOid: '', isDraft: true, state: 'OPEN' },
        ...{ comments: [], createdAt: BEFORE },
      });
    });
    checkRun(tipOf(t), conclusion, run);

    const e = await gather(t, 'building');

    expect(e.redGreen).toEqual(green === undefined ? undefined : { head: tipOf(t), green });
  });

  it('a pending manifest for the same station starts no session; one for another station does not hold', async () => {
    const t = setup();
    await dispatchOnce(t.ctx); // creates the branch and the Specify (station 2) manifest

    expect((await gather(t, 'triaged')).needsSession).toBe(false);
    expect((await gather(t, 'spec-approved')).needsSession).toBe(true);
  });

  it('a session commit dressed as a manifest commit is not a pending manifest', async () => {
    const t = setup({ branch: CREATED });
    t.project.checkout(BRANCH);
    t.project.commit({ 'src/x.ts': 'x\n' }, 'Dispatcher: station 2 (spec) manifest');
    t.project.push(BRANCH);
    t.project.checkout('main');

    expect((await gather(t, 'triaged')).needsSession).toBe(true);
  });

  it('reads the verify report and the Integrate conflict report', async () => {
    const verify = ['| CI | pass |', '| Coverage | pass |', '- [ ] blocking: unsafe eval', ''];
    const integrate = '## Conflicts\n\n- src/login.ts changes behaviour\n';
    const t = setup({
      branch: {
        ...CREATED,
        [`${FEATURE}/reports/verify.md`]: verify.join('\n'),
        [`${FEATURE}/reports/integrate.md`]: integrate,
      },
    });

    const e = await gather(t, 'verifying');

    expect(e).toMatchObject({ verifyReport: false, findingsResolved: false, needsSession: true });
    expect(e.failure).toMatchObject({ station: 4 });
  });

  /** Push a commit on the item branch, as a session would. */
  const later = (t: ReturnType<typeof setup>, files: Record<string, string>) => {
    t.project.checkout(BRANCH);
    t.project.commit(files, 'later');
    t.project.push(BRANCH);
    t.project.checkout('main');
  };

  it('T178: a stale conflict report sends nothing back, and the Integrator runs again', async () => {
    const integrate = '## Conflicts\n\n- src/login.ts\n';
    const t = setup({
      branch: { ...CREATED, [`${FEATURE}/reports/integrate.md`]: integrate },
    });
    later(t, { [`${FEATURE}/.station.json`]: '{"station": 6}\n' });
    expect((await gather(t, 'integrating')).failure).toMatchObject({ station: 4 });

    later(t, { 'src/login.ts': 'resolved\n' });
    const e = await gather(t, 'integrating');

    expect(e.failure).toBeUndefined();
    expect(e.needsSession).toBe(true);
  });

  it('T178: stale Verify reports read as missing, so Verify runs again', async () => {
    const t = setup({
      branch: {
        ...CREATED,
        [`${FEATURE}/reports/verify.md`]: '| Check | Result |\n|---|---|\n| Review | pass |\n',
        [`${FEATURE}/reports/security.md`]:
          '## Scans\n\n- semgrep: none\n\n## Findings\n\n- none\n',
      },
    });
    expect(await gather(t, 'verifying')).toMatchObject({
      ...{ verifyReport: true, securityReport: true, needsSession: false },
    });

    later(t, { 'src/login.ts': 'changed after the review\n' });
    const e = await gather(t, 'verifying');

    expect(e.verifyReport).toBeUndefined();
    expect(e.securityReport).toBeUndefined();
    expect(e.needsSession).toBe(true);
  });
});

describe('Verify results from the required check runs (T168)', { timeout: 60_000 }, () => {
  const LIST = readFileSync(
    new URL('../../factory/profiles/typescript/ci/required-checks.json', import.meta.url),
    'utf8',
  );
  /** A factory clone whose one commit, the pin, holds `list` as the release's required checks. */
  const factoryClone = (list: string | null = LIST) => {
    const path = 'factory/profiles/typescript/ci/required-checks.json';
    const repo = makeRepo({
      files: list === null ? { 'README.md': 'f\n' } : { [path]: list },
    });
    return { path: repo.path, sha: repo.revParse('HEAD') };
  };
  const CI_YML = '.github/workflows/ci.yml';
  const SECURITY_YML = '.github/workflows/security.yml';
  type Ran = [workflow: string, job: string, conclusion: string | null];
  const CI_JOBS = ['build-test', 'coverage', 'ac-map', 'red-green', 'weakened', 'size'];
  /** Every job the release requires of an item that changes no events.jsonl, green. */
  const ITEM_JOBS: Ran[] = [
    ...CI_JOBS.map((job): Ran => [CI_YML, job, 'success']),
    ...['semgrep', 'gitleaks', 'npm-audit', 'licences'].map((job): Ran => [
      SECURITY_YML,
      job,
      'success',
    ]),
  ];
  const withJob = (job: string, conclusion: string | null): Ran[] =>
    ITEM_JOBS.map(([w, j, c]) => [w, j, j === job ? conclusion : c]);
  let nextRun = 700;
  /** GitHub Actions at `sha`: one pull_request run per workflow file, with the jobs that ran. */
  const actionsAt = (sha: string, ran: Ran[]) => {
    editState((repo) => {
      const runs = [...new Set(ran.map(([w]) => w))].map((path) => ({
        ...{ id: nextRun++, path, head_sha: sha, head_branch: BRANCH, event: 'pull_request' },
        ...{ status: 'completed', conclusion: 'success' },
      }));
      repo.api[`repos/${REPO}/actions/runs?head_sha=${sha}&event=pull_request&per_page=100`] = {
        total_count: runs.length,
        workflow_runs: runs,
      };
      for (const run of runs) {
        const jobs = ran
          .filter(([w]) => w === run.path)
          .map(([, name, conclusion], i) => ({
            ...{ id: run.id * 100 + i, name, run_attempt: 1, conclusion },
            status: conclusion === null ? 'in_progress' : 'completed',
          }));
        repo.api[`repos/${REPO}/actions/runs/${String(run.id)}/jobs?filter=all&per_page=100`] = {
          total_count: jobs.length,
          jobs,
        };
      }
    });
  };
  const openPr = () => {
    editState((repo) => {
      repo.prs.push({
        ...{ number: 9, title: '#2', body: '', author: 'owner', headRefName: BRANCH },
        ...{ baseRefName: 'main', headRefOid: '', isDraft: true, state: 'OPEN' },
        ...{ comments: [], createdAt: BEFORE },
      });
    });
  };
  const tipOf = (t: ReturnType<typeof setup>) => t.project.git(['rev-parse', `origin/${BRANCH}`]);
  const SECURITY = '## Scans\n\n- semgrep: none\n\n## Findings\n\n- none\n';
  /** Evidence at Verify, read the way the dispatcher reads it, with `factory` as the release. */
  const verifying = (branch: Record<string, string>, factory = factoryClone()) => {
    const t = setup({ branch: { ...SPECIFIED, ...branch } });
    openPr();
    return { t, factory, tip: tipOf(t) };
  };
  const gatherAt = (
    t: ReturnType<typeof setup>,
    state: 'verifying' | 'building',
    factory?: { path: string; sha: string },
  ) => {
    const issue = { number: ISSUE, title: 'Add login', author: 'owner', body: '', labels: [] };
    const onMain = configOnMain(t.project.path);
    const pin = { ...onMain.factory_release, ...(factory ? { sha: factory.sha } : {}) };
    const ctx = { projectDir: t.project.path, ...(factory ? { factory: factory.path } : {}) };
    return gatherEvidence(ctx)(
      { issue, state, branch: BRANCH, tier: 2 },
      { ...onMain, factory_release: pin },
      { lastVerified: undefined, merges: [], commits: [] },
      writeKeyFiles([owner]),
    );
  };

  it('AC-013: at Verify, reads the pinned release’s item jobs at the head of the item’s PR, from workflow runs', async () => {
    const { t, factory, tip } = verifying({ 'src/login.ts': 'export {};\n' });
    actionsAt(tip, withJob('coverage', 'failure'));

    const e = await gatherAt(t, 'verifying', factory);

    const state = (job: string) => (job === 'coverage' ? 'failure' : 'success');
    expect(e.requiredChecks).toEqual({
      head: tip,
      jobs: ITEM_JOBS.map(([, job]) => ({ job, state: state(job) })),
    });
  });

  it('AC-013: a PR changing events.jsonl also needs append-only, and a job that never ran is missing', async () => {
    const { t, factory, tip } = verifying({ [`${FEATURE}/events.jsonl`]: '{}\n' });
    actionsAt(tip, withJob('gitleaks', null));

    const jobs = (await gatherAt(t, 'verifying', factory)).requiredChecks?.jobs ?? [];

    expect(jobs).toContainEqual({ job: 'gitleaks', state: 'pending' });
    expect(jobs).toContainEqual({ job: 'append-only', state: 'missing' });
  });

  it('AC-013: reads no checks before Verify, or without a PR on the head', async () => {
    const { t, factory, tip } = verifying({});
    actionsAt(tip, ITEM_JOBS);
    expect((await gatherAt(t, 'building', factory)).requiredChecks).toBeUndefined();

    const noPr = setup({ branch: CREATED });
    expect((await gatherAt(noPr, 'verifying', factory)).requiredChecks).toBeUndefined();
  });

  it('AC-013: a pin without required-checks.json, or no factory clone, holds the item with the reason', async () => {
    const { t, factory, tip } = verifying({}, factoryClone(null));
    actionsAt(tip, ITEM_JOBS);

    expect((await gatherAt(t, 'verifying', factory)).requiredChecks).toEqual({
      head: tip,
      jobs: [],
      unreadable:
        'the release pinned on main has no required-checks.json; the item waits in Verify',
    });
    expect((await gatherAt(t, 'verifying')).requiredChecks?.unreadable).toMatch(/no factory clone/);
  });

  it('AC-013: reads reports/security.md: complete with no finding open, or not', async () => {
    const report = `${FEATURE}/reports/security.md`;
    const clean = verifying({ [report]: SECURITY });
    expect((await gatherAt(clean.t, 'verifying')).securityReport).toBe(true);
    const open = SECURITY.replace(
      '- none',
      '- [ ] blocking: eval at src/a.ts:1: input reaches eval',
    );
    const failing = verifying({ [report]: open });
    expect((await gatherAt(failing.t, 'verifying')).securityReport).toBe(false);
    const none = verifying({});
    expect(await gatherAt(none.t, 'verifying')).not.toHaveProperty('securityReport');
  });

  it('AC-013: a red required job keeps the item in Verify, with one info alert per red head', async () => {
    const factory = factoryClone();
    const t = setup({
      pin: `v1.0.0@${factory.sha}`,
      states: ['state:verifying'],
      branch: {
        ...SPECIFIED,
        [`${FEATURE}/reports/verify.md`]: '| Check | Result |\n|---|---|\n| Review | pass |\n',
        [`${FEATURE}/reports/security.md`]: SECURITY,
      },
    });
    t.ctx.gatherEvidence = gatherEvidence({ projectDir: t.project.path, factory: factory.path });
    openPr();
    const red = (tip: string) =>
      `#2: required checks red at ${tip.slice(0, 12)}: semgrep (failure)`;
    const alerts = () =>
      t.inbox().flatMap((c) => {
        const a = parseAlert({ ...c, id: String(c.id) });
        return a?.kind === 'checks-red' ? [`${a.urgency} ${a.text}`] : [];
      });
    const first = tipOf(t);
    actionsAt(first, withJob('semgrep', 'failure'));

    expect((await dispatchOnce(t.ctx)).moves).toEqual([]);
    expect((await dispatchOnce(t.ctx)).moves).toEqual([]);
    expect(alerts()).toEqual([`info ${red(first)}`]);

    t.project.checkout(BRANCH);
    t.project.commit({ 'src/login.ts': 'export {};\n' }, 'fix');
    t.project.push(BRANCH);
    t.project.checkout('main');
    const second = tipOf(t);
    actionsAt(second, withJob('semgrep', 'failure'));
    await dispatchOnce(t.ctx);

    expect(alerts()).toEqual([`info ${red(first)}`, `info ${red(second)}`]);
    expect(t.labels()).toContain('state:verifying');
  });
});

describe('station manifest (T059)', { timeout: 60_000 }, () => {
  it('nextTask: no open task, and a Files list with parenthesised notes', () => {
    expect(nextTask('- [X] T001 Done · Files: a.ts\n')).toBeUndefined();
    const tasks = '- [ ] T004 Form · Files: `src/a.ts`, src/b.ts (shared with T005, T006), c.ts\n';
    expect(nextTask(tasks)).toEqual({ task: 'T004', files: ['src/a.ts', 'src/b.ts', 'c.ts'] });
    expect(nextTask('- [ ] T007 No list\n')).toEqual({ task: 'T007', files: [] });
  });

  it('a Builder manifest without tasks.md names no task, and a missing branch is refused', () => {
    const t = setup({ branch: CREATED });
    const at = { projectDir: t.project.path, now: () => new Date('2026-10-01T11:00:00Z') };

    const manifest = writeStationManifest(
      at,
      { issue: ISSUE, branch: BRANCH },
      {
        station: 4,
        role: 'builder',
      },
    );

    expect(manifest).not.toHaveProperty('task');
    expect(() =>
      writeStationManifest(
        at,
        { issue: 3, branch: 'claude/3-other' },
        { station: 2, role: 'spec' },
      ),
    ).toThrow(/does not exist/);
  });
});

describe('the question loop (T180, AC-033)', { timeout: 60_000 }, () => {
  const ASKING = SPEC.replace(
    '## Problem',
    [
      '## Clarifications',
      '- Q1: Which sign-in should visitors use?',
      '  - Options: A) Email and password B) A magic link C) Both',
      '',
      '## Problem',
    ].join('\n'),
  );
  /** The Owner's answers, committed alone and signed (T182), unless `as` says otherwise. */
  const answer = (
    t: ReturnType<typeof setup>,
    text: string,
    as: { signWith?: TestKeys | null; also?: Files } = {},
  ) => {
    t.project.checkout(BRANCH);
    const signWith = as.signWith === undefined ? owner : as.signWith;
    const files = { [`${FEATURE}/answers.md`]: text, ...as.also };
    const sha = t.project.commit(files, 'Owner answers', signWith === null ? {} : { signWith });
    t.project.push(BRANCH);
    t.project.checkout('main');
    return sha;
  };
  const asking = (spec = ASKING) =>
    setup({ states: ['state:triaged'], branch: { ...CREATED, [`${FEATURE}/spec.md`]: spec } });
  const applied = (rest: string) => ASKING.replace('visitors use?', `visitors use? → A: ${rest}`);

  it('AC-033: an open question in spec.md blocks the item and the Owner is told what it is', async () => {
    const t = asking();

    const result = await dispatchOnce(t.ctx);

    expect(result.moves).toEqual([expect.objectContaining({ from: 'triaged', to: 'blocked' })]);
    expect(t.local.launches).toEqual([]);
    const [alert] = t.inbox().slice(-1);
    expect(alert?.body).toMatch(/urgency=info kind=question/);
    expect(alert?.body).toContain('- Q1 (spec.md): Which sign-in should visitors use?');
    expect(alert?.body).toContain(`${FEATURE}/answers.md on ${BRANCH}`);
  });

  it('AC-033: an answer that does not count keeps it blocked; one that counts returns it to the state it left', async () => {
    const t = asking();
    await dispatchOnce(t.ctx);

    answer(t, 'A1. Both, but only once the link expires\n');
    expect((await dispatchOnce(t.ctx)).moves).toEqual([]);
    expect(t.labels()).toContain('state:blocked');
    expect(t.inbox().at(-1)?.body).toContain('A1 does not count');

    answer(t, 'A1. B\n');
    const back = await dispatchOnce(t.ctx);
    expect(back.moves).toEqual([expect.objectContaining({ from: 'blocked', to: 'triaged' })]);
  });

  it('AC-033: back at Specify, the session runs clarify with the Owner’s answer (T180, slice 24c-2b)', async () => {
    const t = asking();
    await dispatchOnce(t.ctx);
    answer(t, 'A1. B\n');
    await dispatchOnce(t.ctx);
    await dispatchOnce(t.ctx);

    const [launch] = t.local.launches;
    expect(launch).toMatchObject({ station: 2, role: 'spec' });
    expect(launch?.prompt).toContain('## Step 1: speckit-clarify');
    expect(launch?.prompt).toContain('A1. B\n```');
  });

  it.each<[string, { signWith?: TestKeys | null; also?: Files }]>([
    ['unsigned', { signWith: null }],
    ['signed by a key the lists do not name', { signWith: makeOtherKeys() }],
    ['signed, but also changing another file', { also: { 'src/x.ts': 'x\n' } }],
  ])(
    'AC-033 (T182): answers in a commit %s count as none, and the Owner gets an urgent alert naming it',
    async (_name, as) => {
      const t = asking();
      await dispatchOnce(t.ctx);

      const sha = answer(t, 'A1. B\n', as);
      const result = await dispatchOnce(t.ctx);

      expect(result.moves).toEqual([]);
      expect(t.labels()).toContain('state:blocked');
      const alert = t.inbox().find((c) => /kind=tampering/.test(c.body));
      expect(alert?.body).toMatch(/urgency=urgent/);
      expect(alert?.body).toContain(sha.slice(0, 12));
      expect(t.local.launches).toEqual([]);
    },
  );

  it('AC-033 (T182): an applied answer with no line from the Owner is open: the item blocks and the Owner is asked', async () => {
    const t = asking(applied('B'));

    const result = await dispatchOnce(t.ctx);

    expect(result.moves).toEqual([expect.objectContaining({ from: 'triaged', to: 'blocked' })]);
    expect(t.inbox().at(-1)?.body).toContain('- Q1 (spec.md): Which sign-in should visitors use?');
  });

  it.each([
    ['an applied answer that differs from the Owner’s', applied('A')],
    ['an Owner-action question answered differently', applied('C → Owner action: tier raise')],
  ])('AC-033 (T182): %s goes to clarify to apply', async (_name, spec) => {
    const t = asking(spec);
    answer(t, 'A1. B\n');

    await dispatchOnce(t.ctx);

    const [launch] = t.local.launches;
    expect(launch).toMatchObject({ station: 2, role: 'spec' });
    expect(launch?.prompt).toContain('## Step 1: speckit-clarify');
    expect(launch?.prompt).toContain('A1. B\n```');
  });

  it('T182: reading the branch for the prompt, only a missing file is absent; a git failure throws', () => {
    const t = asking();
    const at = { projectDir: t.project.path, now: () => new Date() };
    const keys = writeKeyFiles([owner]);
    t.project.git(['fetch', '-q', 'origin']);
    expect(ownerAnswers(at, BRANCH, 'plan.md', keys)).toEqual([]);
    expect(() => ownerAnswers(at, 'claude/9-not-pushed', 'spec.md', keys)).toThrow();
  });
});
