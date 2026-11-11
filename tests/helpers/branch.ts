// The setup shared by the two dispatcher branch integration files (T053, T059, T060, T168,
// T174, T180): branch.test.ts and branch-rounds.test.ts, split so CI runs them in parallel. A
// project with main's config and the Define merge, the fake GitHub with item #2 approved, the
// fake launchers and the dispatch context, and the spec fixtures both files use.
import { randomBytes } from 'node:crypto';
import { beforeAll } from 'vitest';
import { renderComment } from '../../src/approvals/record.js';
import { sign } from '../../src/approvals/sign.js';
import { type DispatchContext } from '../../src/dispatcher/dispatch.js';
import { gatherEvidence } from '../../src/dispatcher/evidence.js';
import { STATES, STATIONS, type ApprovalRecord, type Tier } from '../../src/model/types.js';
import { FakeClock } from '../helpers/fake-clock.js';
import { FakeLauncher } from '../helpers/fake-launcher.js';
import { readState, seedState, type FakeComment } from '../helpers/fake-gh.js';
import { makeRepo, mergeBrief, type TestRepo } from '../helpers/git-repo.js';
import { makeKeys, tempDir, writeKeyFiles, type TestKeys } from '../helpers/keys.js';
import { testPrompts } from '../helpers/release.js';

export const REPO = 'owner/project';
export const INBOX = 1;
export const ISSUE = 2;
export const BRANCH = 'claude/2-add-login';
export const FEATURE = 'specs/2-add-login';
export const PIN = `v1.0.0@${'a'.repeat(40)}`;
export const BEFORE = '2026-10-01T08:00:00Z';
export const LABELS = [
  ...STATES.map((s) => `state:${s}`),
  ...['owner:approved', 'owner:spec-approved', 'owner:waiver', 'pause:line'],
  ...STATIONS.map((s) => `pause:${s}`),
  ...['type:feature', 'priority:p2', 'tier:1', 'tier:2', 'tier:3'],
].map((name) => ({ name, color: 'ededed', description: '' }));
export const INTAKE_LABELS = ['type:feature', 'priority:p2', 'tier:2'];
/** The installed factory's hash, as the failure record holds it. */
export const HASH = 'f'.repeat(64);

export let owner: TestKeys;
beforeAll(() => {
  owner = makeKeys();
});

export const labeled = (name: string) => ({
  event: 'labeled' as const,
  label: { name },
  actor: { login: 'owner' },
  created_at: BEFORE,
});

export function approvalBody(tier: Tier, more: Partial<ApprovalRecord> = {}): string {
  const record: ApprovalRecord = {
    ...{ repo: REPO, issue: ISSUE, gate: 'approved', tier, branch: BRANCH, ...more },
    ...{ timestamp: BEFORE, nonce: randomBytes(16).toString('hex') },
  };
  return renderComment(record, sign(record, owner.privateKey, { stdinIsTTY: true }));
}

/** An Intake event as the session would post it; `ts` is the session's claim. */
export const intakeEvent = (fields: Record<string, unknown> = {}) => ({
  ts: '1999-01-01T00:00:00Z',
  ...{ item: ISSUE, station: 1, role: 'intake', role_version: 'v1.0.0+0123456789ab' },
  ...{ session: 'intake-1', model: 'claude-sonnet-5-5', kind: 'tool_call', tool: 'gh' },
  ...fields,
});
export const block = (body: string) => '```factory-event\n' + body + '\n```';
export const eventComment = (...events: unknown[]) =>
  events.map((e) => block(JSON.stringify(e))).join('\n\n');

export interface Setup {
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

export function setup(options: Setup = {}) {
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

export function show(project: TestRepo, ref: string, path: string): string {
  project.git(['fetch', '-q', 'origin']);
  return project.git(['show', `${ref}:${path}`]);
}

export const seededLines = (t: ReturnType<typeof setup>) =>
  t
    .show(`${FEATURE}/events.jsonl`)
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

/** Add a canned `ci / red-green` check run for a commit to the fake GitHub. */
export function checkRun(
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
export function editState(
  edit: (repo: NonNullable<ReturnType<typeof readState>['repos'][string]>) => void,
) {
  const state = readState();
  const repo = state.repos[REPO];
  if (repo === undefined) throw new Error('no repo');
  edit(repo);
  seedState(state, process.env.FAKE_GH_STATE);
}

export const SPEC = [
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
export const CREATED = { [`${FEATURE}/events.jsonl`]: '' };
/** A branch at Verify with no new events, so the path-filtered `append-only` job is not required. */
export const SPECIFIED = { [`${FEATURE}/spec.md`]: SPEC };
