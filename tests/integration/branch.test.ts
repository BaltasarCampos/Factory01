import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EnvironmentError } from '../../src/cli/env.js';
import { createItemBranch, dispatcherMessage } from '../../src/dispatcher/branch.js';
import { changedFiles, dispatchOnce } from '../../src/dispatcher/dispatch.js';
import { gatherEvidence } from '../../src/dispatcher/evidence.js';
import {
  failureFile,
  readFailureRecord,
  recordIssued,
  writeFailureRecord,
} from '../../src/dispatcher/failures.js';
import { nextTask, pendingStation, writeStationManifest } from '../../src/dispatcher/manifest.js';
import { groupRecord } from '../../src/dispatcher/launcher/local.js';
import { LaunchRefused, SessionFailed } from '../../src/dispatcher/launcher/types.js';
import { checkIntakeIssue } from '../../src/stations/checks/intake.js';
import { configOnMain } from '../../src/model/config.js';
import { parseAlert } from '../../src/notify/inbox.js';
import { type Tier } from '../../src/model/types.js';
import { readState, seedState, type FakeIssue } from '../helpers/fake-gh.js';
import { gitEnv, mergeIntoMain } from '../helpers/git-repo.js';
import { tempDir, writeKeyFiles } from '../helpers/keys.js';
import {
  REPO,
  INBOX,
  ISSUE,
  BRANCH,
  FEATURE,
  BEFORE,
  INTAKE_LABELS,
  HASH,
  owner,
  approvalBody,
  intakeEvent,
  block,
  eventComment,
  setup,
  seededLines,
  checkRun,
  editState,
  SPEC,
  CREATED,
  SPECIFIED,
} from '../helpers/branch.js';

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

describe('Intake bounded in local mode (T061)', { timeout: 60_000 }, () => {
  const holds = (t: ReturnType<typeof setup>) =>
    t.inbox().flatMap((c) => {
      const a = parseAlert({ ...c, id: String(c.id) });
      return a?.text.startsWith('#2 holds: ') === true ? [`${a.kind} ${a.text}`] : [];
    });
  const passes = async (t: ReturnType<typeof setup>, n: number) => {
    for (let i = 0; i < n; i++) await dispatchOnce(t.ctx);
  };
  const intakeLabels = (labels: string[]) => {
    editState((repo) => {
      const found = repo.issues.find((i) => i.number === ISSUE);
      if (found !== undefined) found.labels = [...labels, 'owner:approved'];
    });
  };

  it('counts every launch, ended well or failed, main moving or not; past retry_limit the item holds in new, alerted once per last session, so a hold after the record is deleted alerts again', async () => {
    const t = setup({ labels: ['tier:2'], config: 'retry_limit: 1\n' });
    const file = failureFile(t.home, REPO, ISSUE, 1);
    await dispatchOnce(t.ctx);
    t.project.commit({ 'notes.md': 'main moved\n' }, 'Notes', { signWith: owner });
    t.project.push('main');
    await passes(t, 3);
    expect(t.local.launches.map((l) => l.station)).toEqual([1, 1]);
    expect(readFailureRecord(file)).toEqual({
      ...{ factory: HASH, count: 2, session: 'fake-local-2', outcome: 'ended' },
    });
    const { missing } = await checkIntakeIssue(REPO, ISSUE, 2);
    const cap = `2 Intake sessions started with retry_limit 1, so no more start while the item is new; the last`;
    const ended = `${cap}, fake-local-2, ended well, but Intake's output is still incomplete: ${missing.join('; ')}; delete ${file} to reset`;
    expect(holds(t)).toEqual([`retry-limit #2 holds: ${ended}`]);

    rmSync(file);
    t.local.failure = new SessionFailed('claude exited 1: \u0007', false);
    await passes(t, 3);
    expect(t.local.launches).toHaveLength(4);
    const failed = `${cap}, fake-local-4, failed: claude exited 1: \\u{7}; delete ${file} to reset`;
    expect(holds(t)).toEqual([`retry-limit #2 holds: ${ended}`, `retry-limit #2 holds: ${failed}`]);
    expect(t.labels()).not.toContain('state:triaged');
  });

  it('holds at once on a full context, under a newly installed factory too, and stops the pass at a last session it cannot tell has ended, launching nothing', async () => {
    const t = setup({ labels: ['tier:2'] });
    const full = new SessionFailed('claude exited 1', false);
    full.contextFull = true;
    t.local.failure = full;
    await passes(t, 2);
    t.evidence.failures.factory = () => 'e'.repeat(64);
    await passes(t, 2);
    expect(t.local.launches).toHaveLength(1);
    const file = failureFile(t.home, REPO, ISSUE, 1);
    expect(holds(t)).toEqual([
      `context-full #2 holds: Intake session fake-local-1 filled its context, so the item is too big for one session: split it; it failed: claude exited 1; delete ${file} to reset`,
    ]);

    // A factory stopped after session.json was written: never read as ended.
    const u = setup({ labels: ['tier:2'] });
    writeFailureRecord(failureFile(u.home, REPO, ISSUE, 1), {
      ...{ factory: HASH, count: 1, session: 'crashed' },
    });
    const dir = join(u.home, '.factory', 'sessions', 'crashed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.json'), '{}');
    await expect(dispatchOnce(u.ctx)).rejects.toThrow(
      /whether session crashed still runs is unknown/,
    );
    expect(u.local.launches).toEqual([]);
  });

  it('deletes the record when the item leaves new, and a failure to delete it stops the pass with the item still in new; cloud mode writes none', async () => {
    const t = setup({ labels: ['tier:2'] });
    await dispatchOnce(t.ctx);
    const file = failureFile(t.home, REPO, ISSUE, 1);
    expect(readFailureRecord(file)).toMatchObject({ count: 1 });
    intakeLabels(INTAKE_LABELS);
    await dispatchOnce(t.ctx);
    expect(t.labels()).toContain('state:triaged');
    expect(readFailureRecord(file)).toBeUndefined();

    const u = setup({ labels: ['tier:2'] });
    const stuck = failureFile(u.home, REPO, ISSUE, 1);
    mkdirSync(join(stuck, 'x'), { recursive: true });
    intakeLabels(INTAKE_LABELS);
    await expect(dispatchOnce(u.ctx)).rejects.toThrow(
      `the failure record ${stuck} cannot be deleted as #2 leaves new`,
    );
    expect(u.labels()).not.toContain('state:triaged');
    expect(u.local.launches).toEqual([]);

    const c = setup({ labels: ['tier:2'], agents: 'cloud' });
    await dispatchOnce(c.ctx);
    expect(c.cloud.launches).toHaveLength(1);
    expect(readFailureRecord(failureFile(c.home, REPO, ISSUE, 1))).toBeUndefined();
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
