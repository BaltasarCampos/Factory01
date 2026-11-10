import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderComment } from '../../src/approvals/record.js';
import { sign } from '../../src/approvals/sign.js';
import { EnvironmentError } from '../../src/cli/env.js';
import { createItemBranch, dispatcherMessage } from '../../src/dispatcher/branch.js';
import {
  changedFiles,
  dispatchOnce,
  ownerAnswers,
  shellWord,
  type DispatchContext,
} from '../../src/dispatcher/dispatch.js';
import { gatherEvidence } from '../../src/dispatcher/evidence.js';
import {
  failureFile,
  readFailureRecord,
  recordIssued,
  writeFailureRecord,
} from '../../src/dispatcher/failures.js';
import {
  nextTask,
  pendingManifest,
  pendingStation,
  writeStationManifest,
} from '../../src/dispatcher/manifest.js';
import { groupRecord } from '../../src/dispatcher/launcher/local.js';
import { LaunchRefused, SessionFailed } from '../../src/dispatcher/launcher/types.js';
import { configOnMain } from '../../src/model/config.js';
import { parseAlert } from '../../src/notify/inbox.js';
import { STATES, STATIONS, type ApprovalRecord, type Tier } from '../../src/model/types.js';
import { FakeClock } from '../helpers/fake-clock.js';
import { FakeLauncher, type LaunchRecord } from '../helpers/fake-launcher.js';
import { readState, seedState, type FakeComment, type FakeIssue } from '../helpers/fake-gh.js';
import {
  gitEnv,
  makeRepo,
  mergeBrief,
  mergeIntoMain,
  type Files,
  type TestRepo,
} from '../helpers/git-repo.js';
import { makeKeys, makeOtherKeys, tempDir, writeKeyFiles, type TestKeys } from '../helpers/keys.js';
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
/** The installed factory's hash, as the failure record holds it. */
const HASH = 'f'.repeat(64);

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

function approvalBody(tier: Tier, more: Partial<ApprovalRecord> = {}): string {
  const record: ApprovalRecord = {
    ...{ repo: REPO, issue: ISSUE, gate: 'approved', tier, branch: BRANCH, ...more },
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
  /** More lines for main's config. */
  config?: string;
  /** Main's `agents:` setting; default local. */
  agents?: 'local' | 'cloud';
  /** A second item, #3, approved and triaged, after this one. */
  other?: boolean;
}

function setup(options: Setup = {}) {
  const config = `factory_release: ${options.pin ?? PIN}\nrepo: ${REPO}\ninbox_issue: ${String(INBOX)}\n`;
  const project = makeRepo({
    files: {
      '.factory/config': `${config}agents: ${options.agents ?? 'local'}\n${options.config ?? ''}`,
    },
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
          ...(options.other === true
            ? [
                {
                  number: 3,
                  title: 'Another item',
                  labels: ['state:triaged', ...INTAKE_LABELS, 'owner:approved'],
                  events: ['state:triaged', 'owner:approved'].map(labeled),
                  comments: [
                    {
                      ...{ id: 6000, author: 'owner', createdAt: BEFORE },
                      body: approvalBody(2, { issue: 3, branch: 'claude/3-other' }),
                    },
                  ],
                },
              ]
            : []),
        ],
      },
    },
  });
  const keys = writeKeyFiles([owner], []);
  const local = new FakeLauncher('local');
  const clock = new FakeClock('2026-10-01T10:00:00Z');
  const home = tempDir();
  const cloud = new FakeLauncher('cloud');
  const evidence = { projectDir: project.path, failures: { home, factory: () => HASH } };
  const ctx: DispatchContext = {
    projectDir: project.path,
    keysFor: () => keys,
    secondCopy: owner.publicKey,
    auditHistory: () => Promise.resolve({ recreated: [] }),
    gatherEvidence: gatherEvidence(evidence),
    launchers: { local, cloud },
    stationPrompt: testPrompts,
    logEvent: () => Promise.resolve(),
    now: () => clock.now(),
    failures: evidence.failures,
  };
  const repoState = () => readState().repos[REPO] ?? { issues: [], prs: [] };
  return {
    ctx,
    project,
    local,
    cloud,
    home,
    evidence,
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
      expect.objectContaining({ role: 'spec', station: 2, branch: BRANCH, feature: FEATURE }),
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
    return gatherEvidence({ ...t.evidence, ...factory })(
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

  /** The dispatcher's manifest for `role` at `station`, as before a session. */
  const manifest = (t: ReturnType<typeof setup>, station: 4 | 5, role: 'builder' | 'test') => {
    writeStationManifest(
      { projectDir: t.project.path, now: () => new Date() },
      { issue: ISSUE, branch: BRANCH },
      { station, role },
      'origin/main',
      (sha, parent) => {
        recordIssued(t.evidence.failures, { repo: REPO, item: ISSUE, station }, sha, parent);
      },
    );
    // The manifest went straight to origin; the next session's commit follows it.
    t.project.git(['branch', '-f', BRANCH, `origin/${BRANCH}`]);
  };
  const REVIEW = {
    [`${FEATURE}/reports/verify.md`]: '| Check | Result |\n|---|---|\n| Review | pass |\n',
  };
  const SECURE = {
    [`${FEATURE}/reports/security.md`]: '## Scans\n\n- semgrep: none\n\n## Findings\n\n- none\n',
  };

  it.each([
    [1, 'reviewer'],
    [2, 'test'],
    [3, 'test'],
  ] as const)('T181: at tier %i, Verify’s first session is the %s', async (tier, role) => {
    const t = setup({ branch: CREATED });
    expect(await gather(t, 'verifying', { tier })).toMatchObject({
      verifyRole: role,
      needsSession: true,
    });
  });

  it('T181: at tier 2, Test, then the Reviewer once Test has ended, then Security once the review is written', async () => {
    const t = setup({ branch: CREATED });
    manifest(t, 5, 'test');
    // Issued but never started, with no session of it live: started again on it (T061).
    expect(await gather(t, 'verifying')).toMatchObject({
      verifyRole: 'test',
      needsSession: true,
      relaunch: { manifest: { station: 5, role: 'test' } },
    });

    later(t, { 'tests/login.test.ts': "it('AC-001: signs in', () => {});\n" });
    expect(await gather(t, 'verifying')).toMatchObject({
      verifyRole: 'reviewer',
      needsSession: true,
    });

    later(t, REVIEW);
    expect(await gather(t, 'verifying')).toMatchObject({
      verifyRole: 'security',
      needsSession: true,
    });

    later(t, SECURE);
    const done = await gather(t, 'verifying');
    expect(done.verifyRole).toBeUndefined();
    expect(done.needsSession).toBe(false);
  });

  it('T181: at tier 2, a current Security report without a current review runs the Reviewer', async () => {
    const t = setup({ branch: { ...CREATED, ...SECURE } });
    expect(await gather(t, 'verifying')).toMatchObject({
      verifyRole: 'reviewer',
      needsSession: true,
    });
    expect(await gather(t, 'verifying')).not.toHaveProperty('verifyEnded');

    later(t, REVIEW);
    const done = await gather(t, 'verifying');
    expect(done.verifyRole).toBeUndefined();
    expect(done.verifyEnded).toBe(true);
  });

  it('T181: at tier 1 the Reviewer alone: once the review is written, no Verify session is left', async () => {
    const t = setup({ branch: { ...CREATED, ...REVIEW } });
    const e = await gather(t, 'verifying', { tier: 1 });
    expect(e.verifyRole).toBeUndefined();
    expect(e.needsSession).toBe(false);
  });

  it('T181: a new Build round after Test runs Test again', async () => {
    const t = setup({ branch: CREATED });
    manifest(t, 5, 'test');
    later(t, { 'tests/login.test.ts': "it('AC-001: signs in', () => {});\n" });
    later(t, REVIEW);
    manifest(t, 4, 'builder');
    later(t, { 'src/login.ts': 'export const fixed = 1;\n' });

    expect(await gather(t, 'verifying')).toMatchObject({ verifyRole: 'test', needsSession: true });
    // Test's manifest after that Build round, and Test's commit: Verify's Test step has ended.
    manifest(t, 5, 'test');
    later(t, { 'tests/login.test.ts': "it('AC-001: signs in again', () => {});\n" });
    expect(await gather(t, 'verifying')).toMatchObject({ verifyRole: 'reviewer' });
  });

  it("T181: Test ends only by the dispatcher's own record: a forged station 5 subject with a commit after it, or the record missing, runs Test (T061)", async () => {
    const t = setup({ branch: CREATED });
    const forged = { item: ISSUE, station: 5, role: 'test', branch: BRANCH };
    t.project.checkout(BRANCH);
    t.project.commit(
      { [`${FEATURE}/.station.json`]: `${JSON.stringify(forged)}\n` },
      dispatcherMessage('station 5 (test) manifest', '2-add-login'),
    );
    t.project.push(BRANCH);
    t.project.checkout('main');
    later(t, { 'tests/login.test.ts': "it('AC-001: signs in', () => {});\n" });
    expect(await gather(t, 'verifying')).toMatchObject({ verifyRole: 'test', needsSession: true });

    manifest(t, 5, 'test');
    later(t, { 'tests/login.test.ts': "it('AC-001: signs in again', () => {});\n" });
    expect(await gather(t, 'verifying')).toMatchObject({ verifyRole: 'reviewer' });
    t.project.git(['update-ref', '-d', `refs/factory/test/${BRANCH}`]);
    expect(await gather(t, 'verifying')).toMatchObject({ verifyRole: 'test', needsSession: true });
  });

  it('T181: without the Owner’s tier, station 5 starts nothing', async () => {
    const t = setup({ branch: CREATED });
    const e = await gather(t, 'verifying', { tier: null });
    expect(e.verifyRole).toBeUndefined();
    expect(e.needsSession).toBe(false);
  });

  it('T181: the dispatcher launches the role the tier names, and its manifest names it', async () => {
    const t = setup({ tier: 1, states: ['state:verifying'], branch: { ...SPECIFIED } });

    await dispatchOnce(t.ctx);

    expect(t.local.launches).toMatchObject([{ station: 5, role: 'reviewer' }]);
    expect(JSON.parse(t.show(`${FEATURE}/.station.json`))).toMatchObject({
      station: 5,
      role: 'reviewer',
    });
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
    const ctx = { ...t.evidence, ...(factory ? { factory: factory.path } : {}) };
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
    t.ctx.gatherEvidence = gatherEvidence({ ...t.evidence, factory: factory.path });
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

  it('T168: required checks that cannot be read hold Verify with one info alert per head, naming why', async () => {
    const factory = factoryClone(null);
    const t = setup({
      pin: `v1.0.0@${factory.sha}`,
      states: ['state:verifying'],
      branch: {
        ...SPECIFIED,
        [`${FEATURE}/reports/verify.md`]: '| Check | Result |\n|---|---|\n| Review | pass |\n',
        [`${FEATURE}/reports/security.md`]: SECURITY,
      },
    });
    t.ctx.gatherEvidence = gatherEvidence({ ...t.evidence, factory: factory.path });
    openPr();
    await dispatchOnce(t.ctx);
    await dispatchOnce(t.ctx);

    const unreadable = t.inbox().flatMap((c) => {
      const a = parseAlert({ ...c, id: String(c.id) });
      return a?.kind === 'checks-unreadable' ? [`${a.urgency} ${a.text}`] : [];
    });
    expect(unreadable).toEqual([
      `info #2: required checks at ${tipOf(t).slice(0, 12)} cannot be read: the release pinned on main has no required-checks.json; the item waits in Verify`,
    ]);
    expect(t.labels()).toContain('state:verifying');
  });

  /** An item at Verify with a failing review, at `tier`, its required checks green at its head. */
  const failingReview = (tier: Tier) => {
    const factory = factoryClone();
    // Tier 2 needs the Owner's approval of this spec.md to start a session.
    const spec = createHash('sha1').update(`blob ${String(Buffer.byteLength(SPEC))}\0${SPEC}`);
    const more = { gate: 'spec-approved' as const, spec_sha: spec.digest('hex') };
    const t = setup({
      ...{ tier, pin: `v1.0.0@${factory.sha}` },
      states: ['state:verifying', ...(tier > 1 ? ['owner:spec-approved'] : [])],
      comments: tier > 1 ? [{ body: approvalBody(tier, more), createdAt: BEFORE }] : [],
      branch: {
        ...SPECIFIED,
        [`${FEATURE}/reports/verify.md`]: '| Check | Result |\n|---|---|\n| Review | fail |\n',
      },
    });
    t.ctx.gatherEvidence = gatherEvidence({ ...t.evidence, factory: factory.path });
    openPr();
    const green = () => {
      actionsAt(tipOf(t), ITEM_JOBS);
    };
    green();
    const alerts = () =>
      t.inbox().flatMap((c) => {
        const a = parseAlert({ ...c, id: String(c.id) });
        return a?.kind === 'verify-failed' ? [`${a.urgency} ${a.text}`] : [];
      });
    const failed = (tip: string) =>
      `info #2: reports/verify.md does not pass at ${tip.slice(0, 12)}; Verify's sessions for its tier have ended and nothing sends it back to Build yet: close this item and file it again`;
    return { t, green, alerts, failed };
  };

  it('T181: a failing tier 1 review alerts once, and a second pass at the same head nothing new', async () => {
    const { t, alerts, failed } = failingReview(1);

    await dispatchOnce(t.ctx);
    await dispatchOnce(t.ctx);

    expect(alerts()).toEqual([failed(tipOf(t))]);
    expect(t.local.launches).toEqual([]);
    expect(t.labels()).toContain('state:verifying');
  });

  it('T181: a failing tier 2 review alerts only once Security has ended', async () => {
    const { t, green, alerts, failed } = failingReview(2);

    await dispatchOnce(t.ctx);
    expect(t.local.launches).toMatchObject([{ station: 5, role: 'security' }]);
    green();
    await dispatchOnce(t.ctx);
    expect(alerts()).toEqual([]);

    // Security's session follows its manifest, which went straight to origin.
    t.project.git(['branch', '-f', BRANCH, `origin/${BRANCH}`]);
    t.project.checkout(BRANCH);
    t.project.commit({ [`${FEATURE}/reports/security.md`]: SECURITY }, 'Security report');
    t.project.push(BRANCH);
    t.project.checkout('main');
    green();
    await dispatchOnce(t.ctx);
    await dispatchOnce(t.ctx);

    expect(alerts()).toEqual([failed(tipOf(t))]);
    expect(t.local.launches).toHaveLength(1);
  });

  describe("Build's round on CI's build-test (T174)", () => {
    const TASKS = [
      '### Tests',
      '- [ ] T001 Login tests (AC-001) · Files: tests/login.test.ts',
      '### Implementation',
      '- [ ] T002 Login form · Files: src/login.ts',
    ].join('\n');
    const TASKS_MD = `${FEATURE}/tasks.md`;
    const BUILD_MANIFEST = 'Dispatcher: station 4 (builder) manifest';
    /** An item in Build at tier 1 whose first task the dispatcher has issued. */
    const issued = async (config?: string, failure?: Error) => {
      const factory = factoryClone();
      const t = setup({
        ...{ tier: 1, pin: `v1.0.0@${factory.sha}`, states: ['state:building'] },
        ...(config === undefined ? {} : { config }),
        branch: { ...SPECIFIED, [TASKS_MD]: TASKS },
      });
      t.ctx.gatherEvidence = gatherEvidence({ ...t.evidence, factory: factory.path });
      if (failure !== undefined) t.local.failure = failure;
      openPr();
      await dispatchOnce(t.ctx);
      return Object.assign(t, { factory });
    };
    /** `files` committed and pushed on origin's branch head, as the session does; the new head. */
    const work = (t: ReturnType<typeof setup>, files: Files = { 'tests/login.test.ts': 't\n' }) => {
      t.project.git(['checkout', '-q', '-B', BRANCH, `origin/${BRANCH}`]);
      const trailers = { 'Factory-Role': 'builder', 'Factory-Item': '2-add-login' };
      t.project.commit(files, 'Login tests', { trailers });
      t.project.push(BRANCH);
      t.project.checkout('main');
      return tipOf(t);
    };
    const buildTest = (sha: string, conclusion: string | null) => {
      actionsAt(sha, [[CI_YML, 'build-test', conclusion]]);
    };
    const alerts = (t: ReturnType<typeof setup>, kind: string) =>
      t.inbox().flatMap((c) => {
        const a = parseAlert({ ...c, id: String(c.id) });
        return a?.kind === kind ? [`${a.urgency} ${a.text}`] : [];
      });
    const task = (t: ReturnType<typeof setup>) =>
      (JSON.parse(t.show(`${FEATURE}/.station.json`)) as { task?: string }).task;

    it('T174: holds Build while build-test runs, then ticks the task in its own commit and issues the next', async () => {
      const t = await issued();
      const head = work(t);
      buildTest(head, null);
      await dispatchOnce(t.ctx);
      expect(t.local.launches).toHaveLength(1);

      buildTest(head, 'success');
      await dispatchOnce(t.ctx);

      expect(t.show(TASKS_MD)).toBe(TASKS.replace('- [ ] T001', '- [X] T001'));
      const tick = t.project.git(['log', '-1', '--format=%P%n%B', `origin/${BRANCH}~1`]);
      expect(tick).toBe(`${head}\n${dispatcherMessage('tick T001', '2-add-login').trim()}`);
      expect(t.local.launches.map((l) => l.station)).toEqual([4, 4]);
      expect(task(t)).toBe('T002');
      // Each session's own settings allow edits of its task's files alone (T061).
      expect(t.local.launches.map(({ feature, files }) => ({ feature, files }))).toEqual([
        { feature: FEATURE, files: ['tests/login.test.ts'] },
        { feature: FEATURE, files: ['src/login.ts'] },
      ]);
    });

    it('T174: a red head gives the Builder the same task again with the failure, in its prompt and its manifest, at most retry_limit times', async () => {
      const t = await issued('retry_limit: 1\n');
      const first = work(t);
      buildTest(first, 'failure');
      await dispatchOnce(t.ctx);
      expect(task(t)).toBe('T001');
      const line = `Your last attempt at T001 left CI red at ${first.slice(0, 12)}: build-test (failure).`;
      expect(t.local.launches[1]?.prompt).toContain(line);
      // The manifest keeps the line, so a relaunch on it gets the same prompt (T061); the first
      // manifest, with no failure, has none.
      const station = `${FEATURE}/.station.json`;
      expect(JSON.parse(t.show(station))).toMatchObject({ task: 'T001', failure: line });
      const issuedFirst = t.project.git(['show', `${first}~1:${station}`]);
      expect(JSON.parse(issuedFirst)).not.toHaveProperty('failure');

      const second = work(t, { 'tests/login.test.ts': 't2\n' });
      buildTest(second, 'failure');
      await dispatchOnce(t.ctx);
      await dispatchOnce(t.ctx);

      expect(t.local.launches).toHaveLength(2);
      expect(t.show(TASKS_MD)).toBe(TASKS);
      expect(alerts(t, 'build-failed')).toEqual([
        `info #2: T001 left CI red at ${second.slice(0, 12)}: build-test (failure), after 2 Build sessions with retry_limit 1; nothing sends it on before T096: close this item and file it again`,
      ]);
    });

    /** Runs `pass` with a `git` first on PATH that fails, exit 128, on any `arg` it is given. */
    const failingGit = async (arg: string, pass: () => Promise<unknown>) => {
      const dir = tempDir();
      const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      const script = `#!/bin/sh\nfor a in "$@"; do [ "$a" = "${arg}" ] && { echo 'fatal: injected' >&2; exit 128; }; done\nexec ${real} "$@"\n`;
      writeFileSync(join(dir, 'git'), script, { mode: 0o755 });
      const path = process.env.PATH;
      process.env.PATH = [dir, path ?? ''].join(delimiter);
      try {
        await pass();
      } finally {
        process.env.PATH = path;
      }
    };

    it('T060: a git failure reading a station file stops the pass, never reads as missing', async () => {
      const t = await issued();
      work(t);

      await failingGit('ls-tree', async () => {
        await expect(dispatchOnce(t.ctx)).rejects.toThrow(/git ls-tree .* failed: fatal: injected/);
      });
      expect(t.local.launches).toHaveLength(1);
    });

    it('T174: a build-test that cannot be read holds Build with one info alert per head, naming why', async () => {
      const t = await issued();
      t.ctx.gatherEvidence = gatherEvidence(t.evidence);
      const head = work(t);
      await dispatchOnce(t.ctx);
      await dispatchOnce(t.ctx);

      expect(t.local.launches).toHaveLength(1);
      expect(alerts(t, 'checks-unreadable')).toEqual([
        `info #2: build-test at ${head.slice(0, 12)} cannot be read: no factory clone to read required-checks.json from; Build waits until it can`,
      ]);
    });

    it('T174: an ancestry check that fails with a git error stops the pass and alerts nothing', async () => {
      const t = await issued();
      buildTest(work(t), 'success');

      await failingGit('--is-ancestor', async () => {
        await expect(dispatchOnce(t.ctx)).rejects.toThrow(/git merge-base failed: fatal: injected/);
      });
      expect(alerts(t, 'tampering')).toEqual([]);
      expect(t.show(TASKS_MD)).toBe(TASKS);
    });

    it("T181: a git failure reading the dispatcher's Test record stops the pass, never reads as not ended", async () => {
      const t = setup({ tier: 2, states: ['state:verifying'], branch: CREATED });
      // Injected on the record's own read, whatever it holds.
      await failingGit(`refs/factory/test/${BRANCH}^{commit}`, async () => {
        await expect(dispatchOnce(t.ctx)).rejects.toThrow(/git rev-parse failed: fatal: injected/);
      });
      expect(t.local.launches).toEqual([]);
    });

    it('T174: with no record in the clone the open task is issued again, then holds at the cap', async () => {
      const t = await issued('retry_limit: 1\n');
      const forget = () => t.project.git(['update-ref', '-d', `refs/factory/build/${BRANCH}`]);
      forget();
      work(t);
      await dispatchOnce(t.ctx);
      expect(t.local.launches).toHaveLength(2);

      forget();
      const head = work(t, { 'tests/login.test.ts': 't2\n' });
      await dispatchOnce(t.ctx);
      await dispatchOnce(t.ctx);

      expect(t.local.launches).toHaveLength(2);
      expect(alerts(t, 'build-failed')).toEqual([
        `info #2: T001 is still open at ${head.slice(0, 12)} after 2 Build sessions with retry_limit 1; nothing sends it on before T096: close this item and file it again`,
      ]);
    });

    it("T061: a session's forged Build manifest whose .station.json does not parse, is 2 MiB, or sits at a path with pathspec magic issues the task again and never throws", async () => {
      // A manifest the dispatcher could have written but for its size, past spawnSync's 1 MiB.
      const big = { item: ISSUE, station: 4, role: 'builder', branch: BRANCH, task: 'T001' };
      const huge = `${JSON.stringify({ ...big, pad: 'x'.repeat(2 * 1024 * 1024) })}\n`;
      // Each sorts first in diff-tree's list: `:(glob)` made ls-tree exit 128, and `:/` made it
      // size the item's real manifest while git show read the forged one.
      const forgeries = [
        { [`${FEATURE}/.station.json`]: '{' },
        { [`${FEATURE}/.station.json`]: huge },
        { [`:/${FEATURE}/.station.json`]: huge },
        { ':(glob)x/.station.json': '{}\n' },
      ];
      for (const files of forgeries) {
        const t = await issued();
        t.project.git(['checkout', '-q', '-B', BRANCH, `origin/${BRANCH}`]);
        t.project.commit(files, BUILD_MANIFEST);
        t.project.push(BRANCH);
        t.project.checkout('main');
        const tip = tipOf(t);
        buildTest(tip, 'success');
        const at = { projectDir: t.project.path, now: () => new Date() };
        expect(pendingManifest(at, tip, FEATURE)).toBe('unreadable');
        await dispatchOnce(t.ctx);

        expect(t.show(TASKS_MD)).toBe(TASKS);
        expect(t.local.launches).toHaveLength(2);
        expect(task(t)).toBe('T001');
        expect(t.project.git(['rev-parse', `origin/${BRANCH}~1`])).toBe(tip);
      }
    });

    it('T061: a spent Build manifest whose record in the clone was deleted waits, pushing nothing', async () => {
      const t = await issued();
      const manifest = tipOf(t);
      t.project.git(['update-ref', '-d', `refs/factory/build/${BRANCH}`]);
      await dispatchOnce(t.ctx);
      await dispatchOnce(t.ctx);

      expect(t.local.launches).toHaveLength(1);
      expect(tipOf(t)).toBe(manifest);
      expect(t.inbox()).toEqual([]);
    });

    it('T061: with a stale record in the clone and the failure record deleted, CI green at a later Build manifest ticks nothing', async () => {
      const t = await issued();
      const first = tipOf(t);
      buildTest(work(t), 'failure');
      // A later pass: its manifest's issued_at differs, so it changes .station.json.
      t.ctx.now = () => new Date('2026-10-01T12:00:00Z');
      await dispatchOnce(t.ctx);
      const second = tipOf(t);
      expect(t.local.launches).toHaveLength(2);
      // As when update-ref failed after the second manifest's push.
      t.project.git(['update-ref', `refs/factory/build/${BRANCH}`, first]);
      rmSync(failureFile(t.home, REPO, ISSUE, 4));
      buildTest(second, 'success');
      await dispatchOnce(t.ctx);

      expect(t.show(TASKS_MD)).toBe(TASKS);
      expect(t.local.launches).toHaveLength(3);
      expect(t.project.git(['rev-parse', `origin/${BRANCH}~1`])).toBe(second);
    });

    it('T061: with its failure record deleted, CI green at the manifest itself ticks nothing, and the task is issued again', async () => {
      const t = await issued();
      const manifest = tipOf(t);
      buildTest(manifest, 'success');
      rmSync(failureFile(t.home, REPO, ISSUE, 4));
      await dispatchOnce(t.ctx);

      expect(t.show(TASKS_MD)).toBe(TASKS);
      expect(t.local.launches).toHaveLength(2);
      expect(task(t)).toBe('T001');
      expect(t.project.git(['rev-parse', `origin/${BRANCH}~1`])).toBe(manifest);
    });

    it("T061: holds Build, naming how to restore the clone's record, when the failure record names a tip the evidence reads as new", async () => {
      const t = await issued();
      const manifest = tipOf(t);
      t.project.git(['update-ref', '-d', `refs/factory/build/${BRANCH}`]);
      // Only the dispatcher's records name the tip as its own manifest.
      const elsewhere = { home: tempDir(), factory: () => HASH };
      t.ctx.gatherEvidence = gatherEvidence({
        ...{ projectDir: t.project.path, failures: elsewhere, factory: t.factory.path },
      });
      const result = await dispatchOnce(t.ctx);
      await dispatchOnce(t.ctx);

      expect(t.local.launches).toHaveLength(1);
      expect(tipOf(t)).toBe(manifest);
      const file = failureFile(t.home, REPO, ISSUE, 4);
      const reason = `no manifest is pushed on ${manifest.slice(0, 12)}: the failure record ${file} names it as the dispatcher's own manifest, which a new one never stacks on; delete it, by its path, to start its count again; the dispatcher's own record of that Build manifest is missing too: restore it with git -C '${t.project.path}' update-ref refs/factory/build/${BRANCH} ${manifest}`;
      expect(result.held).toEqual([{ issue: ISSUE, reason }]);
      expect(alerts(t, 'manifest-held')).toEqual([`info #2 holds: ${reason}`]);
      // The clone's path is one shell word, whatever it holds.
      expect(shellWord("/a b/it's")).toBe(`'/a b/it'\\''s'`);
    });

    /** An item in Build with every task ticked and a current conflict report from Integrate. */
    /**
     * An item in Build with every task ticked and a current conflict report listing `listed`;
     * main then adds each of `conflicts` differently from the branch, signed by the Owner.
     */
    const conflicted = (
      config?: string,
      { listed = ['src/login.ts'], conflicts = ['src/login.ts'] } = {},
    ) => {
      const t = setup({
        ...{ tier: 1, states: ['state:building'] },
        ...(config === undefined ? {} : { config }),
        branch: {
          ...{ ...SPECIFIED, [TASKS_MD]: TASKS.replace(/- \[ \]/g, '- [X]') },
          ...Object.fromEntries(conflicts.map((path) => [path, 'branch\n'])),
          [`${FEATURE}/reports/integrate.md`]: `## Conflicts\n\n${listed.map((p) => `- \`${p}\`\n`).join('')}`,
        },
      });
      if (conflicts.length > 0) {
        t.project.commit(
          Object.fromEntries(conflicts.map((path) => [path, 'main\n'])),
          'Main moved',
          { signWith: owner },
        );
        t.project.push('main');
      }
      return t;
    };

    it('T174: the conflict session takes the files git finds conflicted, not the ones the report lists', async () => {
      const listed = ['src/login.ts', 'src/extra.ts'];
      const t = conflicted(undefined, { listed, conflicts: ['src/login.ts', 'src/other.ts'] });
      await dispatchOnce(t.ctx);

      const manifest = JSON.parse(t.show(`${FEATURE}/.station.json`)) as { files?: string[] };
      // An extra file the report lists is left out; a conflict main gained later is in.
      expect(manifest.files).toEqual(['src/login.ts', 'src/other.ts']);
    });

    it('T174: a conflict report git cannot confirm issues no session, with one alert', async () => {
      const t = conflicted(undefined, { conflicts: [] });
      await dispatchOnce(t.ctx);
      await dispatchOnce(t.ctx);

      expect(t.local.launches).toEqual([]);
      expect(alerts(t, 'build-failed')).toEqual([
        `info #2: reports/integrate.md lists conflicts with main, but git merges origin/main into ${BRANCH} at ${tipOf(t).slice(0, 12)} with none, so no conflict session is issued; nothing sends it on before T096: close this item and file it again`,
      ]);
    });

    it('T174: a git failure reading tasks.md stops the manifest, never reads as a conflict session', async () => {
      const t = conflicted();
      const at = { projectDir: t.project.path, now: () => new Date() };
      await failingGit('ls-tree', () => {
        const write = () =>
          writeStationManifest(
            at,
            { issue: ISSUE, branch: BRANCH },
            { station: 4, role: 'builder' },
          );
        expect(write).toThrow(/git ls-tree .* failed: fatal: injected/);
        return Promise.resolve();
      });
    });

    it('T174: a merge-tree that fails stops the pass and issues nothing', async () => {
      const t = conflicted();
      await failingGit('merge-tree', async () => {
        await expect(dispatchOnce(t.ctx)).rejects.toThrow(/git merge-tree failed: fatal: injected/);
      });
      expect(t.local.launches).toEqual([]);
    });

    it('T174: a current conflict report starts a Build session with no task and the listed files, which the Builder’s merge ends', async () => {
      const t = conflicted();
      await dispatchOnce(t.ctx);

      const manifest = JSON.parse(t.show(`${FEATURE}/.station.json`)) as Record<string, unknown>;
      expect(manifest).toMatchObject({ station: 4, role: 'builder', files: ['src/login.ts'] });
      expect(manifest).not.toHaveProperty('task');
      expect(t.local.launches[0]?.prompt).toContain('Integrate sent this item back');
      expect(manifest.failure).toMatch(/^Integrate sent this item back/);
      // Any commit but a clean merge of main makes the report stale.
      work(t, { 'src/login.ts': 'resolved\n' });
      await dispatchOnce(t.ctx);
      expect(t.local.launches).toHaveLength(1);
    });

    it('T174: past retry_limit conflict sessions, Build holds with one alert', async () => {
      const t = conflicted('retry_limit: 1\n');
      t.project.git(['checkout', '-q', '-B', BRANCH, `origin/${BRANCH}`]);
      for (const at of ['09', '10'])
        t.project.commit(
          {
            [`${FEATURE}/.station.json`]: `{"item":2,"station":4,"files":[],"issued_at":"${at}"}\n`,
          },
          dispatcherMessage('station 4 (builder) manifest', '2-add-login'),
        );
      t.project.commit({ [`${FEATURE}/reports/verify.md`]: 'x\n' }, 'Review');
      t.project.push(BRANCH);
      t.project.checkout('main');
      await dispatchOnce(t.ctx);
      await dispatchOnce(t.ctx);

      expect(t.local.launches).toEqual([]);
      expect(alerts(t, 'build-failed')).toEqual([
        `info #2: the conflict with main is still open at ${tipOf(t).slice(0, 12)} after 2 Build sessions with retry_limit 1; nothing sends it on before T096: close this item and file it again`,
      ]);
    });

    it('T174: a rewritten branch with a forged manifest commit is never ticked, and the Owner gets one urgent alert', async () => {
      const t = await issued();
      const pushed = tipOf(t);
      t.project.git(['checkout', '-q', '-B', BRANCH, `origin/${BRANCH}~1`]);
      const forged = { item: 2, station: 4, role: 'builder', branch: BRANCH, task: 'T001' };
      t.project.commit(
        { [`${FEATURE}/.station.json`]: `${JSON.stringify({ ...forged, files: [] })}\n` },
        dispatcherMessage('station 4 (builder) manifest', '2-add-login'),
      );
      t.project.push(BRANCH, { force: true });
      const head = work(t);
      buildTest(head, 'success');
      await dispatchOnce(t.ctx);
      await dispatchOnce(t.ctx);

      expect(t.show(TASKS_MD)).toBe(TASKS);
      expect(t.local.launches).toHaveLength(1);
      expect(alerts(t, 'tampering')).toEqual([
        `urgent #2: the Build manifest the dispatcher pushed, ${pushed.slice(0, 12)}, is not in the history of ${BRANCH} at ${head.slice(0, 12)}: the branch was rewritten, so nothing more is ticked or issued for this item; close it and file it again`,
      ]);
    });

    /** What a launch was given, its callbacks and session id aside. */
    const given = (l?: LaunchRecord) =>
      l === undefined
        ? undefined
        : { ...l, starting: undefined, heartbeat: undefined, sessionId: undefined };
    /** The failure record of the item at `station`. */
    const recordAt = (t: ReturnType<typeof setup>, station: 2 | 4 | 5) =>
      readFailureRecord(failureFile(t.home, REPO, ISSUE, station));
    const passes = async (t: ReturnType<typeof setup>, n: number) => {
      const results = [];
      for (let i = 0; i < n; i++) results.push(await dispatchOnce(t.ctx));
      return results;
    };

    it('T061: a failing session is started again on its spent manifest retry_limit times, then holds with one alert and no branch commit, at Specify and at Build', async () => {
      const failure = new SessionFailed('claude exited 1: \u0007', false);
      // One at a time: each setup seeds the fake GitHub anew.
      const cases = [
        [
          async () => {
            const spec = setup({ config: 'retry_limit: 2\n' });
            spec.local.failure = failure;
            await dispatchOnce(spec.ctx); // the manifest and its first attempt, as issued() does
            return spec;
          },
          2,
        ],
        [() => issued('retry_limit: 2\n', failure), 4],
      ] as const;
      for (const [make, station] of cases) {
        const t = await make();
        const manifest = tipOf(t);
        const results = await passes(t, 3);

        // retry_limit + 1 attempts, each on the one manifest commit, and nothing pushed after it.
        expect(t.local.launches).toHaveLength(3);
        expect(tipOf(t)).toBe(manifest);
        expect(recordAt(t, station)).toMatchObject({ head: manifest, count: 3, outcome: 'failed' });
        const file = failureFile(t.home, REPO, ISSUE, station);
        const reason = `3 sessions started at ${manifest.slice(0, 12)} with retry_limit 2, so no more start there; the last failure: claude exited 1: \\u{7}; the failure record is ${file}; delete it to start its count again, or push a new head or install a new factory release`;
        expect(results.at(-1)?.held).toEqual([{ issue: ISSUE, reason }]);
        expect(alerts(t, 'retry-limit')).toEqual([`info #2 holds: ${reason}`]);
      }
    });

    it('T061: a full context holds at once with one alert; an unknown one is an ordinary failure, started again with the same prompt', async () => {
      const t = setup();
      const full = new SessionFailed('claude exited 1', false);
      full.contextFull = true;
      t.local.failure = full;
      await passes(t, 3);
      expect(t.local.launches).toHaveLength(1);
      const manifest = tipOf(t);
      const file = failureFile(t.home, REPO, ISSUE, 2);
      expect(alerts(t, 'context-full')).toEqual([
        `info #2 holds: the session at ${manifest.slice(0, 12)} filled its context, so the item is too big for one session: split it; the last failure: claude exited 1; the failure record is ${file}; delete it to start its count again`,
      ]);

      const u = setup();
      u.local.failure = new SessionFailed('claude exited 1', false);
      await passes(u, 2);
      expect(recordAt(u, 2)).toMatchObject({ count: 2, context_full: null });
      const [first, again] = u.local.launches;
      // Nothing else changed, so the relaunch's prompt and settings are the first attempt's.
      expect(given(again)).toEqual(given(first));
      expect(again?.sessionId).toBe('fake-local-2');
      expect(u.project.git(['log', '-1', '--format=%s', `origin/${BRANCH}`])).toBe(
        'Dispatcher: station 2 (spec) manifest',
      );
    });

    it('T061: a refusal is not counted and is tried again each pass with one alert; once fixed the session starts on the same manifest, and so does a stale head check', async () => {
      const t = setup();
      t.local.refusal = new LaunchRefused('no local session started: claude is not on PATH');
      await passes(t, 3);
      const manifest = tipOf(t);
      expect(t.local.asked).toHaveLength(3);
      expect(recordAt(t, 2)).toEqual({ head: manifest, factory: HASH, count: 0 });
      expect(alerts(t, 'launcher-unavailable')).toHaveLength(1);
      delete t.local.refusal;
      await dispatchOnce(t.ctx);
      expect(t.local.launches).toHaveLength(1);
      expect(tipOf(t)).toBe(manifest);

      // The head check saw a push the branch then lost: refused uncounted, at a tip that reads
      // as unmoved, and the session starts there on the next pass.
      const u = setup();
      u.local.beforeStart = () => {
        u.project.git(['checkout', '-q', '-B', BRANCH, `origin/${BRANCH}`]);
        u.project.commit({ [`${FEATURE}/notes.md`]: 'late\n' }, 'a late push');
        u.project.push(BRANCH);
        u.project.checkout('main');
      };
      expect((await dispatchOnce(u.ctx)).held?.[0]?.reason).toMatch(
        /the branch moved after its manifest/,
      );
      delete u.local.beforeStart;
      const issuedAt = u.project.git(['rev-parse', `origin/${BRANCH}~1`]);
      u.project.git(['push', '-q', '-f', 'origin', `${issuedAt}:refs/heads/${BRANCH}`]);
      await dispatchOnce(u.ctx);
      expect(u.local.launches).toHaveLength(1);
      expect(recordAt(u, 2)).toMatchObject({ head: issuedAt, count: 1, outcome: 'ended' });
    });

    it('T061: an attempt with no outcome is started again once no group of it lives, read by sessionRunning alone', async () => {
      const t = setup();
      t.local.failure = new Error('the factory was stopped');
      await expect(dispatchOnce(t.ctx)).rejects.toThrow('the factory was stopped');
      expect(recordAt(t, 2)).not.toHaveProperty('outcome');
      delete t.local.failure;
      const dir = join(t.home, '.factory', 'sessions', 'fake-local-1');
      mkdirSync(dir, { recursive: true });
      const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
      await once(child, 'spawn');
      const pgid = child.pid;
      if (pgid === undefined) throw new Error('sleep has no pid');
      try {
        writeFileSync(join(dir, 'group.json'), JSON.stringify(groupRecord(pgid)));
        await dispatchOnce(t.ctx);
        expect(t.local.launches).toHaveLength(1);
      } finally {
        process.kill(-pgid, 'SIGKILL');
      }
      await vi.waitFor(() => {
        expect(() => process.kill(-pgid, 0)).toThrow();
      });
      await dispatchOnce(t.ctx);
      expect(t.local.launches).toHaveLength(2);
      expect(recordAt(t, 2)).toMatchObject({ count: 2, session: 'fake-local-2', outcome: 'ended' });
    });

    it('T061: after a red CI round, a session failing on the re-issued manifest is started again with its failure line, and CI green at that manifest ticks nothing', async () => {
      const t = await issued();
      const head = work(t);
      buildTest(head, 'failure');
      t.local.failure = new SessionFailed('claude exited 1', false);
      await dispatchOnce(t.ctx); // the re-issued manifest, whose session fails
      const manifest = tipOf(t);
      buildTest(manifest, 'success');
      await dispatchOnce(t.ctx);

      const line = `Your last attempt at T001 left CI red at ${head.slice(0, 12)}: build-test (failure).`;
      const [, reissued, relaunched] = t.local.launches;
      expect(reissued?.prompt).toContain(line);
      expect(given(relaunched)).toEqual(given(reissued));
      expect(tipOf(t)).toBe(manifest);
      expect(t.show(TASKS_MD)).toBe(TASKS);
      expect(recordAt(t, 4)).toMatchObject({ head: manifest, count: 2 });
    });

    it("T061: a Verify relaunch keeps its manifest's role, whatever the evidence would name", async () => {
      const t = setup({ tier: 1, states: ['state:verifying'], branch: { ...SPECIFIED } });
      const at = { projectDir: t.project.path, now: () => new Date() };
      const records = t.ctx.failures;
      const where = { repo: REPO, item: ISSUE, station: 5 } as const;
      // The dispatcher's own Security manifest, failed, where the evidence at tier 1 names the
      // Reviewer.
      writeStationManifest(
        at,
        { issue: ISSUE, branch: BRANCH },
        { station: 5, role: 'security' },
        'origin/main',
        (sha, parent) => {
          recordIssued(records, where, sha, parent);
        },
      );
      const manifest = tipOf(t);
      const file = failureFile(t.home, REPO, ISSUE, 5);
      writeFailureRecord(file, {
        head: manifest,
        factory: HASH,
        count: 1,
        outcome: 'failed',
        last: 'x',
      });

      await dispatchOnce(t.ctx);

      expect(t.local.launches).toMatchObject([{ station: 5, role: 'security' }]);
      expect(tipOf(t)).toBe(manifest);
    });

    it("T061: the dispatcher's own manifest that cannot be read holds its item with one urgent alert and the pass goes on; a git failure reading it stops the pass", async () => {
      const t = setup({ branch: CREATED, states: ['state:triaged'], other: true });
      const tip = tipOf(t);
      // A record naming a commit that is no manifest: the factory's bug or local corruption.
      const file = failureFile(t.home, REPO, ISSUE, 2);
      writeFailureRecord(file, { head: tip, factory: HASH, count: 1, outcome: 'failed' });
      await passes(t, 2);

      expect(tipOf(t)).toBe(tip);
      expect(t.local.launches.map((l) => l.item)).toEqual([3]);
      expect(alerts(t, 'manifest-unreadable')).toEqual([
        `urgent #2 holds: the dispatcher's own manifest at ${tip}, which the failure record ${file} names, cannot be read as one, so no session starts on it: reinstall the pinned release, or delete ${file}`,
      ]);
      // Reading the dispatcher's own failed manifest, git fails: the pass stops.
      const u = setup();
      u.local.failure = new SessionFailed('claude exited 1', false);
      await dispatchOnce(u.ctx);
      await failingGit('--literal-pathspecs', async () => {
        await expect(dispatchOnce(u.ctx)).rejects.toThrow('git ls-tree failed: fatal: injected');
      });
      expect(u.local.launches).toHaveLength(1);
    });
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

  const tip = (t: ReturnType<typeof setup>) => {
    t.project.git(['fetch', '-q', 'origin']);
    return t.project.git(['rev-parse', `origin/${BRANCH}`]);
  };

  it('in local mode records its manifest commit before pushing it, and in cloud mode records nothing (T061)', async () => {
    const t = setup();
    await dispatchOnce(t.ctx); // creates the branch and the Specify (station 2) manifest

    expect(t.local.launches).toHaveLength(1);
    const record = readFailureRecord(failureFile(t.home, REPO, ISSUE, 2));
    // The session's id is in it before the session can run.
    expect(record).toEqual({
      ...{ head: tip(t), factory: HASH, count: 1, session: 'fake-local-1' },
      outcome: 'ended',
    });
    expect(t.show(`${FEATURE}/.station.json`)).toMatch(/"station": 2/);

    const cloud = setup({ agents: 'cloud' });
    await dispatchOnce(cloud.ctx);
    expect(cloud.cloud.launches).toHaveLength(1);
    expect(readdirSync(cloud.home)).toEqual([]);
  });

  it('counts each attempt when it starts, before claude spawns: a factory stopped mid-session has it counted, a refusal before the start does not (T061)', async () => {
    const stopped = setup();
    stopped.local.failure = new Error('the factory was stopped');
    await expect(dispatchOnce(stopped.ctx)).rejects.toThrow('the factory was stopped');
    const record = readFailureRecord(failureFile(stopped.home, REPO, ISSUE, 2));
    expect(record).toEqual({
      head: tip(stopped),
      factory: HASH,
      count: 1,
      session: 'fake-local-1',
    });

    const refused = setup();
    refused.local.refusal = new LaunchRefused('no local session started: no gh token');
    await dispatchOnce(refused.ctx);
    const none = readFailureRecord(failureFile(refused.home, REPO, ISSUE, 2));
    expect(none).toEqual({ head: tip(refused), factory: HASH, count: 0 });
  });

  it('pushes no manifest while the launcher finds a session still running, with one urgent alert of its kind (T061)', async () => {
    const t = setup({ branch: CREATED, states: ['state:triaged'] });
    const before = tip(t);
    const reason = 'no local session started: session x is still running';
    t.local.available = () =>
      Promise.resolve({ ok: false, reason, urgent: true, kind: 'session-running' });
    await dispatchOnce(t.ctx);
    await dispatchOnce(t.ctx);

    expect(tip(t)).toBe(before);
    expect(t.local.launches).toEqual([]);
    const running = t.inbox().filter((c) => /kind=session-running/.test(c.body));
    expect(running).toHaveLength(1);
  });

  it('in local mode records how a failed session ended after it: its text through visible() and its full context (T061)', async () => {
    const t = setup();
    const failure = new SessionFailed('claude exited 1: \u0007', false);
    failure.contextFull = true;
    t.local.failure = failure;
    await dispatchOnce(t.ctx);

    expect(readFailureRecord(failureFile(t.home, REPO, ISSUE, 2))).toMatchObject({
      ...{ count: 1, session: 'fake-local-1', outcome: 'failed' },
      ...{ last: 'claude exited 1: \\u{7}', context_full: true },
    });
  });

  it('in local mode records the outcome before the alert, so a failed post never skips it (T061)', async () => {
    const t = setup();
    t.local.failure = new SessionFailed('claude exited 1', false);
    // The inbox is gone by the time the session ends: its alert cannot be posted.
    t.local.beforeStart = () => {
      editState((repo) => {
        repo.issues = repo.issues.filter((i) => i.number !== INBOX);
      });
    };
    await expect(dispatchOnce(t.ctx)).rejects.toThrow();

    expect(readFailureRecord(failureFile(t.home, REPO, ISSUE, 2))).toMatchObject({
      ...{ count: 1, session: 'fake-local-1', outcome: 'failed', last: 'claude exited 1' },
    });
  });

  it('in local mode posts the failed-session alert when its outcome cannot be recorded, naming why, and then stops the pass (T061)', async () => {
    const t = setup();
    t.local.failure = new SessionFailed('claude exited 1', false);
    const file = failureFile(t.home, REPO, ISSUE, 2);
    // The record is replaced while the session runs, so its outcome no longer has one to go in.
    t.local.afterStart = () => {
      const record = readFailureRecord(file);
      if (record === undefined) throw new Error('no record');
      writeFailureRecord(file, { ...record, session: 'another-session' });
    };
    const lost = `the failure record ${file} no longer names session fake-local-1 at`;
    await expect(dispatchOnce(t.ctx)).rejects.toThrow(lost);

    const [alert, ...more] = heldAlerts(t, 'session-failed');
    expect(more).toEqual([]);
    expect(alert).toMatch(
      new RegExp(
        `^info a spec session for ${REPO}#${String(ISSUE)} failed: claude exited 1; nothing of it is pushed; its outcome could not be recorded: ${lost.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`,
      ),
    );
    expect(readFailureRecord(file)).not.toHaveProperty('outcome');
  });

  it('pushes no manifest when its record cannot be written or the factory cannot be hashed (T061)', async () => {
    const unhashable = () => {
      throw new EnvironmentError('the installed factory cannot be hashed: x: EACCES');
    };
    const cases = [
      [true, () => HASH, /^the failure record .*2-2\.json cannot be read: .*ENOTDIR/],
      [false, unhashable, /^the installed factory cannot be hashed: /],
    ] as const;
    for (const [blocked, factory, why] of cases) {
      const t = setup({ branch: CREATED, states: ['state:triaged'] });
      if (blocked) writeFileSync(join(t.home, '.factory'), '');
      t.ctx.failures = { home: t.home, factory };
      const before = tip(t);

      await expect(dispatchOnce(t.ctx)).rejects.toThrow(why);

      expect(tip(t)).toBe(before);
      expect(t.local.launches).toEqual([]);
    }
  });

  it('in local mode waits on its own manifest by the record alone, and issues one on any other tip (T061)', async () => {
    const t = setup();
    await dispatchOnce(t.ctx); // the Specify manifest, recorded
    const spent = tip(t);
    await dispatchOnce(t.ctx);
    expect(t.local.launches).toHaveLength(1);
    expect(tip(t)).toBe(spent);

    // The session's own commit is a new head: a new manifest, and a new record for it.
    t.project.git(['checkout', '-q', '-B', BRANCH, `origin/${BRANCH}`]);
    t.project.commit({ [`${FEATURE}/notes.md`]: 'notes\n' }, 'session work');
    t.project.push(BRANCH);
    await dispatchOnce(t.ctx);
    expect(t.local.launches).toHaveLength(2);
    const record = readFailureRecord(failureFile(t.home, REPO, ISSUE, 2));
    expect(record).toEqual({
      ...{ head: tip(t), factory: HASH, count: 1, session: 'fake-local-2' },
      outcome: 'ended',
    });

    // A commit that only looks like the dispatcher's manifest is a new head in local mode, while
    // cloud mode's T059 rule waits on it.
    for (const agents of ['local', 'cloud'] as const) {
      const u = setup({ agents });
      await dispatchOnce(u.ctx);
      u.project.git(['checkout', '-q', '-B', BRANCH, `origin/${BRANCH}`]);
      const forged = { [`${FEATURE}/.station.json`]: '{ "station": 2, "role": "spec" }\n' };
      u.project.commit(forged, dispatcherMessage('station 2 (spec) manifest', '2-add-login'));
      u.project.push(BRANCH);
      await dispatchOnce(u.ctx);
      expect(u[agents].launches).toHaveLength(agents === 'local' ? 2 : 1);
    }
  });

  /**
   * A manifest's subject on origin's branch whose `.station.json` is an entry of `mode` naming
   * `object`, as plumbing writes a symlink or a gitlink, the working copy untouched.
   */
  const entryAt = (t: ReturnType<typeof setup>, mode: string, object: string) => {
    const env = { ...gitEnv, GIT_INDEX_FILE: join(tempDir(), 'index') };
    const g = (...args: string[]) =>
      execFileSync('git', args, { cwd: t.project.path, env, encoding: 'utf8' }).trim();
    const parent = tip(t);
    g('read-tree', parent);
    g('update-index', '--add', '--cacheinfo', `${mode},${object},${FEATURE}/.station.json`);
    const message = dispatcherMessage('station 2 (spec) manifest', '2-add-login');
    const commit = g('commit-tree', g('write-tree'), '-p', parent, '-m', message);
    g('push', '-q', 'origin', `${commit}:refs/heads/${BRANCH}`);
  };

  it("in cloud mode reads a manifest's subject whose .station.json is not a manifest, a symlink or a gitlink included, as no session pending, and issues one (T059, T061)", async () => {
    const texts = ['{', '{}', 'null', '{ "station": 2, "role": "\\u001b[2Kspec" }'];
    const forgeries = [
      ...texts.map((text) => (t: ReturnType<typeof setup>) => {
        t.project.git(['checkout', '-q', '-B', BRANCH, `origin/${BRANCH}`]);
        const files = { [`${FEATURE}/.station.json`]: `${text}\n` };
        t.project.commit(files, dispatcherMessage('station 2 (spec) manifest', '2-add-login'));
        t.project.push(BRANCH);
      }),
      (t: ReturnType<typeof setup>) => {
        const at = { cwd: t.project.path, env: gitEnv, encoding: 'utf8' } as const;
        const link = execFileSync('git', ['hash-object', '-w', '--stdin'], {
          ...at,
          input: '../../package.json',
        }).trim();
        entryAt(t, '120000', link);
      },
      (t: ReturnType<typeof setup>) => {
        entryAt(t, '160000', 'a'.repeat(40));
      },
    ];
    for (const forge of forgeries) {
      const t = setup({ agents: 'cloud' });
      await dispatchOnce(t.ctx);
      forge(t);
      const forged = tip(t);
      const at = { projectDir: t.project.path, now: () => new Date() };

      expect(pendingStation(at, forged, FEATURE)).toBeUndefined();
      await dispatchOnce(t.ctx);
      expect(t.cloud.launches).toHaveLength(2);
      expect(t.project.git(['rev-parse', `origin/${BRANCH}~1`])).toBe(forged);
    }
  });

  it('in local mode tells its own manifest running while its last session’s group lives and spent once it has ended, stopping on a group record it cannot read (T061)', async () => {
    const t = setup();
    await dispatchOnce(t.ctx); // the Specify manifest, its record naming fake-local-1
    const seen: (string | undefined)[] = [];
    const evidence = t.ctx.gatherEvidence;
    t.ctx.gatherEvidence = async (...args) => {
      const found = await evidence(...args);
      seen.push(found.ownManifest);
      return found;
    };
    // The group lives under the home the records are in, where the launcher keeps its sessions.
    const dir = join(t.home, '.factory', 'sessions', 'fake-local-1');
    mkdirSync(dir, { recursive: true });
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    // With no pid, killing group 0 would kill the test runner's own group.
    await once(child, 'spawn');
    const pgid = child.pid;
    if (pgid === undefined) throw new Error('sleep has no pid');
    try {
      writeFileSync(join(dir, 'group.json'), JSON.stringify(groupRecord(pgid)));
      await dispatchOnce(t.ctx);
    } finally {
      process.kill(-pgid, 'SIGKILL');
    }
    await vi.waitFor(() => {
      expect(() => process.kill(-pgid, 0)).toThrow();
    });
    await dispatchOnce(t.ctx);
    expect(seen).toEqual(['running', 'spent']);
    expect(t.local.launches).toHaveLength(1);

    // Never read as spent: a group record that is not one, or one that cannot be read.
    writeFileSync(join(dir, 'group.json'), '{}');
    await expect(dispatchOnce(t.ctx)).rejects.toThrow(
      `${join(dir, 'group.json')} cannot be read: it is not a process group record`,
    );
    rmSync(dir, { recursive: true });
    writeFileSync(dir, '');
    await expect(dispatchOnce(t.ctx)).rejects.toThrow(
      new RegExp(`^${join(dir, 'group.json')} cannot be read: ENOTDIR`),
    );
    expect(t.local.launches).toHaveLength(1);
  });

  it("never stacks a manifest on the dispatcher's own spent one, whose count it would wipe (T061)", () => {
    const t = setup({ branch: CREATED });
    const at = { projectDir: t.project.path, now: () => new Date('2026-10-01T11:00:00Z') };
    const before = tip(t);
    const file = failureFile(t.home, REPO, ISSUE, 2);
    writeFailureRecord(file, { head: before, factory: HASH, count: 2, last: 'it exited 1' });
    const records = { home: t.home, factory: () => HASH };
    const issued = (sha: string, parent: string) => {
      recordIssued(records, { repo: REPO, item: ISSUE, station: 2 }, sha, parent);
    };

    expect(() =>
      writeStationManifest(
        at,
        { issue: ISSUE, branch: BRANCH },
        { station: 2, role: 'spec' },
        'origin/main',
        issued,
      ),
    ).toThrow(
      `no manifest is pushed on ${before.slice(0, 12)}: the failure record ${file} names it`,
    );

    expect(tip(t)).toBe(before);
    expect(readFailureRecord(file)).toMatchObject({ head: before, count: 2 });
  });

  const heldAlerts = (t: ReturnType<typeof setup>, kind: string) =>
    t.inbox().flatMap((c) => {
      const a = parseAlert({ ...c, id: String(c.id) });
      return a?.kind === kind ? [`${a.urgency} ${a.text}`] : [];
    });

  it('in local mode a failed session, or a launch refused after the push, is started again on its spent manifest with no new one and no throw (T061)', async () => {
    const failures = [
      new SessionFailed('claude exited 1', false),
      new LaunchRefused('no local session started: claude is not on PATH'),
    ];
    for (const failure of failures) {
      const t = setup();
      if (failure instanceof LaunchRefused) t.local.refusal = failure;
      else t.local.failure = failure;
      const first = await dispatchOnce(t.ctx);
      const manifest = tip(t);
      const second = await dispatchOnce(t.ctx);

      for (const pass of [first, second])
        expect(pass.failed ?? pass.refused).toContain(failure.message);
      expect(t.local.asked).toHaveLength(2);
      expect(tip(t)).toBe(manifest);
      // A refusal before the start leaves no session in the record and no count; each failed
      // session was counted as it started.
      const session =
        failure instanceof LaunchRefused
          ? { count: 0 }
          : { count: 2, session: 'fake-local-2', outcome: 'failed', last: failure.message };
      const full = failure instanceof LaunchRefused ? {} : { context_full: null };
      expect(readFailureRecord(failureFile(t.home, REPO, ISSUE, 2))).toEqual({
        ...{ head: manifest, factory: HASH },
        ...session,
        ...full,
      });
    }
  });

  it('in local mode holds, uncounted and with no launch, a session whose record was replaced after its manifest (T061)', async () => {
    const t = setup();
    const file = failureFile(t.home, REPO, ISSUE, 2);
    t.local.beforeStart = () => {
      writeFailureRecord(file, { head: 'd'.repeat(40), factory: HASH, count: 0 });
    };
    const result = await dispatchOnce(t.ctx);
    const manifest = tip(t).slice(0, 12);

    expect(t.local.launches).toEqual([]);
    const reason = `no local session started: the failure record ${file} does not name ${manifest}, the manifest this session starts on; run the factory again; ${BRANCH} is at ${manifest}`;
    expect(result.held).toEqual([{ issue: ISSUE, reason }]);
    expect(result.refused).toBeUndefined();
    expect(heldAlerts(t, 'launcher-unavailable')).toEqual([`info #2 holds: ${reason}`]);
  });

  it("in local mode holds an item the launcher refuses alone, uncounted and tried again each pass on its manifest, starts the next item's session in the same pass, and alerts once per head (T061)", async () => {
    const t = setup({ other: true });
    const refused = `no local session started: ${BRANCH} has no .claude/agents/spec.md; close this item and file it again`;
    t.local.refusalFor = (request) =>
      request.item === ISSUE ? new LaunchRefused(refused, false, undefined, true) : undefined;
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await dispatchOnce(t.ctx));
    const manifest = tip(t);

    // Item #3 started in the first pass; #2 held every pass on its one manifest, never counted.
    expect(results[0]?.launched).toMatchObject({ issue: 3 });
    expect(t.local.launches.map((l) => l.item)).toEqual([3]);
    const reason = `${refused}; ${BRANCH} is at ${manifest.slice(0, 12)}`;
    for (const r of results) expect(r.held).toEqual([{ issue: ISSUE, reason }]);
    expect(readFailureRecord(failureFile(t.home, REPO, ISSUE, 2))).toEqual({
      head: manifest,
      factory: HASH,
      count: 0,
    });
    expect(heldAlerts(t, 'launcher-unavailable')).toEqual([`info #2 holds: ${reason}`]);
  });

  it('in local mode holds, uncounted and with no launch, a session whose branch moved after its manifest, and issues a new one on the new head (T061)', async () => {
    const t = setup();
    const file = failureFile(t.home, REPO, ISSUE, 2);
    // A push between the evidence and the launch, which clones the branch as origin has it.
    t.local.beforeStart = () => {
      t.project.git(['checkout', '-q', '-B', BRANCH, `origin/${BRANCH}`]);
      t.project.commit({ [`${FEATURE}/notes.md`]: 'late\n' }, 'a late push');
      t.project.push(BRANCH);
      t.project.checkout('main');
    };
    const result = await dispatchOnce(t.ctx);
    const late = tip(t);
    const manifest = t.project.git(['rev-parse', `${late}~1`]);

    expect(t.local.launches).toEqual([]);
    expect(result.held).toEqual([
      {
        issue: ISSUE,
        reason: `no local session started: the session's clone is at ${late.slice(0, 12)}, not ${manifest.slice(0, 12)}, which ${file} names: the branch moved after its manifest was issued; run the factory again; ${BRANCH} is at ${late.slice(0, 12)}`,
      },
    ]);
    expect(readFailureRecord(file)).toEqual({ head: manifest, factory: HASH, count: 0 });

    delete t.local.beforeStart;
    await dispatchOnce(t.ctx);
    expect(t.local.launches).toHaveLength(1);
    expect(t.project.git(['rev-parse', `origin/${BRANCH}~1`])).toBe(late);
  });

  it('starts no session, with one urgent alert and nothing recorded, when the launcher for agents: local runs another mode (T061)', async () => {
    const t = setup();
    t.ctx.launchers = { local: t.cloud };
    const result = await dispatchOnce(t.ctx);
    await dispatchOnce(t.ctx);

    const refused = `no session started for ${REPO}: the launcher configured for agents: local runs cloud sessions; this is the factory's own error, so reinstall the pinned release`;
    expect(result.refused).toBe(refused);
    expect(heldAlerts(t, 'launcher-missing')).toEqual([`urgent ${refused}`]);
    expect(t.cloud.launches).toEqual([]);
    expect(readdirSync(t.home)).toEqual([]);
  });

  it("in local mode holds an item whose record names its tip while the evidence reads a new head, once per head, and starts the next item's session (T061)", async () => {
    const t = setup({ branch: CREATED, states: ['state:triaged'], other: true });
    const before = tip(t);
    // The dispatcher's records are not the evidence's: only they name the tip as its own.
    const records = { home: tempDir(), factory: () => HASH };
    t.ctx.failures = records;
    const file = failureFile(records.home, REPO, ISSUE, 2);
    writeFailureRecord(file, { head: before, factory: HASH, count: 2 });

    const first = await dispatchOnce(t.ctx);
    const second = await dispatchOnce(t.ctx);

    expect(tip(t)).toBe(before);
    expect(readFailureRecord(file)).toMatchObject({ head: before, count: 2 });
    const reason = `no manifest is pushed on ${before.slice(0, 12)}: the failure record ${file} names it as the dispatcher's own manifest, which a new one never stacks on; delete it, by its path, to start its count again`;
    expect(first.held).toEqual([{ issue: ISSUE, reason }]);
    expect(first.launched).toMatchObject({ issue: 3, station: 2, branch: 'claude/3-other' });
    expect(t.local.launches.map((l) => l.item)).toEqual([3]);
    expect(second.held?.[0]).toEqual({ issue: ISSUE, reason });
    expect(heldAlerts(t, 'manifest-held').filter((a) => a.startsWith('info #2 '))).toEqual([
      `info #2 holds: ${reason}`,
    ]);
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
      expect(alert?.body).toContain(
        'If the commit is yours, close this item and file it again; if it is not, look into it before anything else.',
      );
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
