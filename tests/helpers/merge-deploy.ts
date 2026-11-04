// The setup shared by the `factory merge` and `factory deploy` integration tests (T053), split
// into tests/integration/merge-command.test.ts and deploy-command.test.ts so CI runs them in
// parallel: a signed project with a bare origin, fake `gh` state, CI runs and signed records.
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderComment } from '../../src/approvals/record.js';
import { ownerKeyPath, sign } from '../../src/approvals/sign.js';
import { runCli } from '../../src/cli/commands.js';
import { loadRequiredChecks } from '../../src/merge/ci.js';
import { type MergeRulesInput } from '../../src/merge/rules.js';
import type { ApprovalRecord } from '../../src/model/types.js';
import { SEED_MARKER } from '../../src/stations/checks/define.js';
import {
  readState,
  seedState,
  type FakeComment,
  type FakeIssue,
  type FakeLabelEvent,
  type FakePr,
} from './fake-gh.js';
import {
  gitEnv,
  makeRepo,
  mergeBrief,
  runGit,
  signedReleaseTag,
  type Files,
  type TestRepo,
} from './git-repo.js';
import { makeKeys, makeOtherKeys, tempDir, writeKeyFiles, type TestKeys } from './keys.js';

export const REPO = 'owner/project';
export const FACTORY_REPO = 'BaltasarCampos/Factory01';
export const PR = 40;
export const AT = '2026-10-11T10:00:00Z';

export let owner: TestKeys;
export let other: TestKeys;
export function makeTestKeys(): void {
  owner = makeKeys();
  other = makeOtherKeys();
}

export const config = (pin: string, extra = '') =>
  `factory_release: ${pin}\nrepo: ${REPO}\ninbox_issue: 1\nagents: local\n${extra}`;

/** A project with a signed main; returns it with main's head. */
export function project(files: Files = {}): { repo: TestRepo; main: string } {
  const repo = makeRepo({
    files: { '.factory/config': config(`v1.0.0@${'a'.repeat(40)}`), 'src/a.ts': 'a\n', ...files },
    signWith: owner,
  });
  return { repo, main: repo.revParse('main') };
}

/** A branch off main with `files` committed; returns its head. */
export function branch(repo: TestRepo, name: string, files: Files): string {
  repo.checkout('main');
  repo.checkout(name, { create: true });
  const head = repo.commit(files, `work on ${name}`);
  repo.checkout('main');
  return head;
}

export function input(
  repo: TestRepo,
  main: string,
  name: string,
  head: string,
  over: Partial<MergeRulesInput> = {},
): MergeRulesInput {
  const keys = writeKeyFiles([owner]);
  return {
    ...{ repo: repo.path, branch: name, head, main, keys, laptopKeys: keys },
    ...{ secondCopy: owner.publicKey, factory: repo.path, factoryRepo: FACTORY_REPO },
    ...over,
  };
}

// `factory merge` itself, slice 22a: the checks before the merge, which ends every run with
// "the merge itself comes with slice 22b; nothing was merged" until slice 22b lands.
export const ITEM = 7;
export const ITEM_BRANCH = 'claude/7-add-login';
export const ITEM_PR = 8;
export const ITEM_SPEC = `# Add login

## Problem

Visitors cannot sign in.

1. **AC-001** — **Given** a user, **When** they sign in, **Then** they see their links.
`;
// The item's code and its tagged test: red at the base, where the code is missing, green at the head.
export const LOGIN = 'export const login = (name: string) => name.length > 0;\n';
export const VERIFY_REPORT = '| Check | Result |\n|---|---|\n| Review | pass |\n';
export const SECURITY_REPORT = '## Scans\n\n- semgrep: none\n\n## Findings\n\n- none\n';
export const LOGIN_TEST = [
  "import { expect, it } from 'vitest';",
  "import { login } from '../src/login.js';",
  "it('AC-001 signs in', () => { expect(login('ada')).toBe(true); });",
  '',
].join('\n');
export const REQUIRED_PATH = 'factory/profiles/typescript/ci/required-checks.json';
export const REQUIRED = loadRequiredChecks(
  readFileSync(
    join(
      import.meta.dirname,
      '..',
      '..',
      'factory',
      'profiles',
      'typescript',
      'ci',
      'required-checks.json',
    ),
    'utf8',
  ),
);
export interface ActionsJob {
  /** The workflow file it ran from. */
  workflow: string;
  name: string;
  conclusion: string | null;
  attempt: number;
}
/** A job of the workflow run from `workflow`; `conclusion` null while it runs. */
export const actionsJob = (
  workflow: string,
  name: string,
  conclusion: string | null,
  attempt = 1,
): ActionsJob => ({ workflow, name, conclusion, attempt });
export const CI = '.github/workflows/ci.yml';
/** Every listed job green, from the workflow file it is installed at. */
export const allGreen = (except: string[] = []) =>
  REQUIRED.jobs
    .filter((j) => !except.includes(j.job))
    .map((j) => actionsJob(j.installed, j.job, 'success'));
export let nextRun = 5000;

/**
 * What GitHub Actions shows for `sha`: one pull_request workflow run per workflow file, with its
 * jobs over every attempt. By default every listed job is green.
 */
export function actionsAt(
  sha: string,
  jobs: ActionsJob[] = allGreen(),
  earlierFailed: string[] = [],
) {
  const state = readState();
  const repo = state.repos[REPO];
  if (repo === undefined) throw new Error('seed the fake GitHub first');
  const run = { head_sha: sha, event: 'pull_request', status: 'completed' };
  // Earlier runs of a workflow file at the same commit, from closing and reopening the PR.
  const earlier = earlierFailed.map((path) => ({
    ...run,
    id: nextRun++,
    path,
    conclusion: 'failure',
  }));
  const latest = [...new Set(jobs.map((j) => j.workflow))].map((path) => ({
    ...{ ...run, id: nextRun++, path, conclusion: 'success' },
  }));
  const runs = [...earlier, ...latest];
  repo.api[`repos/${REPO}/actions/runs?head_sha=${sha}&event=pull_request&per_page=100`] = {
    total_count: runs.length,
    workflow_runs: runs,
  };
  for (const run of latest) {
    const ran = jobs
      .filter((j) => j.workflow === run.path)
      .map((j, i) => ({
        ...{ id: run.id * 100 + i, name: j.name, run_attempt: j.attempt },
        ...{
          status: j.conclusion === null ? 'in_progress' : 'completed',
          conclusion: j.conclusion,
        },
      }));
    repo.api[`repos/${REPO}/actions/runs/${String(run.id)}/jobs?filter=all&per_page=100`] = {
      total_count: ran.length,
      jobs: ran,
    };
  }
  writeFileSync(process.env.FAKE_GH_STATE ?? '', JSON.stringify(state));
}
/**
 * CI on main's head as GitHub Actions shows it: one push run of ci.yml at `sha` on `branch`, its
 * `job` with `conclusion`, null while it runs (slice 23c-1b). `event` is the run's own field: the
 * fake answers the push query with it, as a filter GitHub might ignore; `none`: no run at all.
 */
export function pushRunAt(
  sha: string,
  conclusion: string | null = 'success',
  { branch = 'main', job = 'build-test', event = 'push', none = false } = {},
) {
  const state = readState();
  const repo = state.repos[REPO];
  if (repo === undefined) throw new Error('seed the fake GitHub first');
  const status = conclusion === null ? 'in_progress' : 'completed';
  const run = { id: nextRun++, path: CI, head_sha: sha, head_branch: branch, event };
  repo.api[`repos/${REPO}/actions/runs?head_sha=${sha}&event=push&per_page=100`] = {
    total_count: none ? 0 : 1,
    workflow_runs: none ? [] : [{ ...run, status, conclusion }],
  };
  repo.api[`repos/${REPO}/actions/runs/${String(run.id)}/jobs?filter=all&per_page=100`] = {
    total_count: 1,
    jobs: [{ id: run.id * 100, name: job, run_attempt: 1, status, conclusion }],
  };
  writeFileSync(process.env.FAKE_GH_STATE ?? '', JSON.stringify(state));
}
export const signersOf = (keys: TestKeys[]) =>
  keys.map((k) => `${k.allowedSignersLine}\n`).join('');
export const labeledAt = (name: string, at: string): FakeLabelEvent => ({
  event: 'labeled',
  label: { name },
  actor: { login: 'owner' },
  created_at: at,
});

export interface MergeSetup {
  /** The tier in the item's `approved` record; no record when null. */
  tier?: 1 | 2 | 3 | null;
  /** Files the item branch adds besides its spec and source. */
  files?: Files;
  /** The PR's head branch, when not the item's. */
  branch?: string;
  /** Keys the pinned release and the laptop list, oldest first. */
  release?: TestKeys[];
  /** Main has no `.factory/config`. */
  noConfig?: boolean;
  /** Label events on the Owner inbox. */
  inbox?: FakeLabelEvent[];
  /** Runs on the project once main is set up, before the item branch. */
  project?: (repo: TestRepo) => void;
  /** A second release's allowed_signers, pinned on main by a signed commit before the branch. */
  nextRelease?: string;
  /** The item's labels, when not `tier:<tier>` and `owner:approved`. */
  labels?: string[];
  /** The repository the PR's head branch lives in, when it is a fork. */
  headRepository?: string;
  /** The item's records as posted, from the standard chain (approved, then spec-approved). */
  chain?: (at: { head: string; specBlob: string }, standard: Posted[]) => Posted[];
  /** Main has no merged Define brief. */
  noBrief?: boolean;
  /** The head branch's commits in order, in place of the item's one commit. */
  commits?: Files[];
  /** Commits after the default first one (T179). */
  then?: Files[];
  /** More issues on the project. */
  issues?: (Partial<FakeIssue> & { number: number })[];
  /** The pull request's fields besides its number and head branch. */
  pr?: Partial<FakePr>;
}

/** A record of the item's chain as posted: its comment, and the owner: label added after it. */
export interface Posted {
  comment: FakeComment;
  label?: FakeLabelEvent;
}

/** A record for the item, bound to its branch at tier 2 unless `fields` say otherwise. */
export const itemRecord = (gate: ApprovalRecord['gate'], fields: Partial<ApprovalRecord> = {}) =>
  ({
    ...{ repo: REPO, issue: ITEM, gate, tier: 2, branch: ITEM_BRANCH },
    ...{ timestamp: '2026-10-01T08:00:00Z', nonce: randomBytes(16).toString('hex') },
    ...fields,
  }) as ApprovalRecord;

/** `record` signed with `keys`, posted at `at`, with its owner: label added a minute later. */
export function posted(id: number, record: ApprovalRecord, at: string, keys = owner): Posted {
  const body = renderComment(record, sign(record, keys.privateKey, { stdinIsTTY: true }));
  const later = new Date(Date.parse(at) + 60_000).toISOString().replace('.000Z', 'Z');
  return {
    comment: { id, author: 'owner', body, createdAt: at },
    label: labeledAt(`owner:${record.gate}`, later),
  };
}

export function mergeSetup(o: MergeSetup = {}) {
  const release = o.release ?? [owner];
  const factory = makeRepo({
    files: {
      allowed_signers: signersOf(release),
      revoked_keys: '',
      'factory/workflows/ci.yml': `env:\n  FACTORY_REPO: ${FACTORY_REPO}\n`,
      [REQUIRED_PATH]: JSON.stringify(REQUIRED),
    },
  });
  signedReleaseTag(factory, owner);
  const pin = `v1.0.0@${factory.revParse('HEAD')}`;
  const repo = makeRepo({
    files: o.noConfig
      ? { 'src/a.ts': 'a\n' }
      : { '.factory/config': config(pin), 'src/a.ts': 'a\n' },
    signWith: owner,
  });
  if (!o.noConfig && !o.noBrief) mergeBrief(repo, { signWith: owner });
  if (o.nextRelease !== undefined) {
    factory.commit({ allowed_signers: o.nextRelease }, 'next release');
    signedReleaseTag(factory, owner, 'v1.0.1');
    const next = `v1.0.1@${factory.revParse('HEAD')}`;
    repo.commit({ '.factory/config': config(next) }, 'pin v1.0.1', { signWith: owner });
    repo.push('main');
  }
  o.project?.(repo);
  const branchName = o.branch ?? ITEM_BRANCH;
  const [first = {}, ...more] = o.commits ?? [
    {
      'specs/7-add-login/spec.md': ITEM_SPEC,
      'src/login.ts': LOGIN,
      'tests/login.test.ts': LOGIN_TEST,
      'specs/7-add-login/reports/verify.md': VERIFY_REPORT,
      'specs/7-add-login/reports/security.md': SECURITY_REPORT,
      ...o.files,
    },
    ...(o.then ?? []),
  ];
  let head = branch(repo, branchName, first);
  if (more.length > 0) {
    repo.checkout(branchName);
    // The Owner's answers are signed and alone in their commit, as factory merge requires (T182).
    const owners = (files: Files) => Object.keys(files).some((p) => p.endsWith('answers.md'));
    for (const files of more)
      head = repo.commit(files, `more on ${branchName}`, owners(files) ? { signWith: owner } : {});
    repo.checkout('main');
  }
  repo.push(branchName);

  const home = tempDir('factory-home-');
  mkdirSync(join(home, '.factory', 'keys'), { recursive: true });
  writeFileSync(join(home, '.factory', 'allowed_signers'), signersOf(release));
  writeFileSync(join(home, '.factory', 'revoked_keys'), '');
  copyFileSync(owner.privateKey, ownerKeyPath(home));
  chmodSync(ownerKeyPath(home), 0o600);
  copyFileSync(owner.publicKeyPath, `${ownerKeyPath(home)}.pub`);

  const tier = o.tier === undefined ? 2 : o.tier;
  const specPath = `${head}:specs/7-add-login/spec.md`;
  const hasSpec = repo.git(['ls-tree', '--name-only', head, 'specs/7-add-login/spec.md']) !== '';
  const specBlob = hasSpec ? runGit(repo.path, ['rev-parse', specPath]) : '';
  // A head with no item spec is not an item: there is no chain to post.
  const standard: Posted[] =
    tier === null || !hasSpec
      ? []
      : [
          posted(900, itemRecord('approved', { tier }), '2026-10-01T08:00:00Z'),
          ...(tier === 1
            ? []
            : [
                posted(
                  901,
                  itemRecord('spec-approved', { tier, spec_sha: specBlob }),
                  '2026-10-01T08:30:00Z',
                ),
              ]),
        ];
  const chain = o.chain?.({ head, specBlob }, standard) ?? standard;
  const gates = [
    ...new Set(chain.flatMap((p) => (p.label === undefined ? [] : [p.label.label.name]))),
  ];
  seedState({
    repos: {
      [REPO]: {
        origin: repo.origin,
        labels: [
          ...['owner:approved', 'owner:spec-approved', 'owner:waiver'],
          ...['pause:line', 'tier:1', 'tier:2', 'tier:3'],
        ].map((name) => ({ name, color: 'ededed', description: '' })),
        issues: [
          { number: 1, title: 'Owner inbox', events: o.inbox ?? [] },
          {
            number: ITEM,
            title: 'Add login',
            labels: o.labels ?? [`tier:${String(tier ?? 2)}`, ...gates],
            comments: chain.map((p) => p.comment),
            events: chain.flatMap((p) => (p.label === undefined ? [] : [p.label])),
          },
          ...(o.issues ?? []),
        ],
        prs: [
          {
            ...{ ...o.pr, number: ITEM_PR, headRefName: branchName },
            ...(o.headRepository === undefined ? {} : { headRepository: o.headRepository }),
          },
        ],
      },
    },
  });

  const asked: string[] = [];
  const cli = async (argv = ['merge', String(ITEM_PR)], over: CliOver = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const answers = [...(over.answers ?? [])];
    const env: NodeJS.ProcessEnv = {
      ...gitEnv,
      ...process.env,
      HOME: home,
      FACTORY_SOURCE: factory.path,
    };
    delete env.CLAUDE_CODE_REMOTE;
    Object.assign(env, over.env);
    const code = await runCli(argv, {
      stdout: { write: (s: string) => void out.push(s) },
      stderr: { write: (s: string) => void err.push(s) },
      ...{ env, stdinIsTTY: over.tty ?? true, cwd: repo.path },
      unreadAlerts: () => Promise.resolve([]),
      ...(over.healthMs === undefined ? {} : { healthMs: over.healthMs }),
      ...(over.startMs === undefined ? {} : { startMs: over.startMs }),
      ...(over.steadyMs === undefined ? {} : { steadyMs: over.steadyMs }),
      ...(over.now === undefined ? {} : { now: over.now }),
      ask: (question) => {
        asked.push(question);
        const answer = answers.shift() ?? '';
        return Promise.resolve(typeof answer === 'function' ? answer() : answer);
      },
    });
    return { code, stdout: out.join(''), stderr: err.join('') };
  };
  actionsAt(head);
  const mainOnOrigin = () => runGit(repo.origin, ['rev-parse', 'main']);
  /** Origin shows as the factory repository on GitHub; fetches still reach the bare origin. */
  const asFactoryRepository = (): CliOver => {
    const url = `https://github.com/${FACTORY_REPO}.git`;
    repo.git(['remote', 'set-url', 'origin', url]);
    const global = join(home, 'gitconfig');
    writeFileSync(global, `[url "${repo.origin}"]\n\tinsteadOf = ${url}\n`);
    return { env: { GIT_CONFIG_GLOBAL: global } };
  };
  return { repo, factory, head, home, cli, asked, mainOnOrigin, asFactoryRepository };
}

export interface CliOver {
  /** Typed answers in order; a function runs when its question is asked, then answers. */
  answers?: (string | (() => string))[];
  env?: NodeJS.ProcessEnv;
  tty?: boolean;
  /** The deploy's health check window, through the command context (slice 23c-2). */
  healthMs?: number;
  /** The start check's windows, the same way. */
  startMs?: number;
  steadyMs?: number;
  now?: () => Date;
}

// Slice 22c: Define, log and factory-repository branches may be behind main, so what lands is
// git's merge of the two, checked on an unsigned probe commit before the prompt.
export const LOG_BRANCH = 'claude/factory-log';
export const seed = (number: number, body = `${SEED_MARKER}\nA seed issue.\n`) => ({
  ...{ number, title: `Seed ${String(number)}`, body, labels: ['tier:2'] },
});
export const merged = (repo: TestRepo, ref = 'main') => ({
  parents: runGit(repo.origin, ['rev-list', '--parents', '-n', '1', ref]).split(' ').slice(1),
  message: runGit(repo.origin, ['log', '-1', '--format=%B', ref]),
});
export const branchOnOrigin = (repo: TestRepo, name: string) =>
  runGit(repo.origin, ['rev-parse', '--verify', `refs/heads/${name}`]);
/** `files` committed on main by the Owner and pushed; returns the new head. */
export function onMain(repo: TestRepo, files: Files, message: string, edit?: () => void): string {
  repo.checkout('main');
  edit?.();
  const sha = repo.commit(files, message, { signWith: owner });
  repo.push('main');
  return sha;
}
