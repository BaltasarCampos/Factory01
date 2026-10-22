// `factory merge` and `factory deploy` (T053). Slice 21 writes the per-branch rule cases
// (AC-081–AC-083, AC-086, FR-016g) against src/merge/rules.ts, with the inputs `factory merge`
// will pass in; the command's own cases come with slices 22a to 22c, and deploy's with 23a to 23c.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ReleaseKeys } from '../../src/approvals/keys.js';
import { NonceLedger, nonceLedgerPath } from '../../src/approvals/nonces.js';
import { extractFromComment, parse, renderComment } from '../../src/approvals/record.js';
import { ownerKeyPath, sign } from '../../src/approvals/sign.js';
import { matchFields, verifyGate, verifySignature } from '../../src/approvals/verify.js';
import { runCli } from '../../src/cli/commands.js';
import { serialiseManifest } from '../../src/install/manifest.js';
import { deploysLogPath } from '../../src/deploy/deploys-log.js';
import { stamp } from '../../src/deploy/release.js';
import { appFolder } from '../../src/deploy/sandbox.js';
import { unitName, unitRelease } from '../../src/deploy/service.js';
import { checkAppendOnly } from '../../src/ci/append-only.js';
import { loadRequiredChecks } from '../../src/merge/ci.js';
import {
  mergeRules,
  originRepo,
  releaseSource,
  type MergeRulesInput,
  type PullRequest,
} from '../../src/merge/rules.js';
import type { ApprovalRecord } from '../../src/model/types.js';
import { NO_FORMAL } from '../../src/notify/summary.js';
import { briefMerged, verifiedMerges } from '../../src/git/merges.js';
import { SEED_MARKER } from '../../src/stations/checks/define.js';
import {
  calls,
  readState,
  seedState,
  type FakeComment,
  type FakeIssue,
  type FakeLabelEvent,
  type FakePr,
} from '../helpers/fake-gh.js';
import {
  gitEnv,
  makeRepo,
  mergeBrief,
  mergeIntoMain,
  runGit,
  signedReleaseTag,
  type Files,
  type TestRepo,
} from '../helpers/git-repo.js';
import { manifestOf } from '../helpers/guardrails.js';
import { makeKeys, makeOtherKeys, tempDir, writeKeyFiles, type TestKeys } from '../helpers/keys.js';

vi.setConfig({ testTimeout: 60_000 });

const REPO = 'owner/project';
const FACTORY_REPO = 'BaltasarCampos/Factory01';
const PR = 40;
const AT = '2026-10-11T10:00:00Z';
const LATER = '2026-10-11T10:05:00Z';

let owner: TestKeys;
let other: TestKeys;
beforeAll(() => {
  owner = makeKeys();
  other = makeOtherKeys();
});

const config = (pin: string, extra = '') =>
  `factory_release: ${pin}\nrepo: ${REPO}\ninbox_issue: 1\nagents: local\n${extra}`;

/** A project with a signed main; returns it with main's head. */
function project(files: Files = {}): { repo: TestRepo; main: string } {
  const repo = makeRepo({
    files: { '.factory/config': config(`v1.0.0@${'a'.repeat(40)}`), 'src/a.ts': 'a\n', ...files },
    signWith: owner,
  });
  return { repo, main: repo.revParse('main') };
}

/** A branch off main with `files` committed; returns its head. */
function branch(repo: TestRepo, name: string, files: Files): string {
  repo.checkout('main');
  repo.checkout(name, { create: true });
  const head = repo.commit(files, `work on ${name}`);
  repo.checkout('main');
  return head;
}

function input(
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

describe('merge rules: item and Define pull requests (T143, AC-086)', () => {
  it.each(['claude/12-add-login', 'claude/define'])(
    '%s passes when it changes no protected path',
    (name) => {
      const { repo, main } = project();
      const head = branch(repo, name, { 'src/login.ts': 'export {};\n' });

      const result = mergeRules(input(repo, main, name, head));

      expect(result).toEqual({
        rule: name === 'claude/define' ? 'define' : 'item',
        problems: [],
        ...(name === 'claude/define' ? {} : { issue: 12 }),
      });
    },
  );

  it.each([
    '.claude/settings.json',
    '.github/workflows/ci.yml',
    '.mcp.json',
    '.gitattributes',
    'src/.gitmodules',
    '.factory/config',
    '.specify/memory/constitution.md',
  ])('an item touching %s is refused, whatever else it carries', (path) => {
    const { repo, main } = project();
    const head = branch(repo, 'claude/12-add-login', { [path]: 'changed\n', 'src/b.ts': 'b\n' });

    const result = mergeRules(input(repo, main, 'claude/12-add-login', head));

    expect(result.rule).toBe('item');
    expect(result.problems).toEqual([expect.stringContaining(path) as string]);
  });

  it('a Define pull request adding a symlink where a guarded folder belongs is refused', () => {
    const { repo, main } = project();
    repo.checkout('claude/define', { create: true });
    symlinkSync('/tmp', join(repo.path, '.claude'));
    const head = repo.commit({}, 'link');
    repo.checkout('main');

    expect(mergeRules(input(repo, main, 'claude/define', head)).problems).toEqual([
      expect.stringContaining('.claude') as string,
    ]);
  });
});

describe('merge rules: claude/factory-log (T143, AC-081, AC-082)', () => {
  const LOG = 'claude/factory-log';
  const base: Files = { '.factory/events/2026-10.jsonl': '{"a":1}\n' };

  it('passes lines appended to log files under the allowed paths', () => {
    const { repo, main } = project(base);
    const head = branch(repo, LOG, {
      '.factory/events/2026-10.jsonl': '{"a":1}\n{"b":2}\n',
      '.factory/lessons/builder.md': '- a lesson\n',
    });

    expect(mergeRules(input(repo, main, LOG, head))).toEqual({ rule: 'factory-log', problems: [] });
  });

  it.each([
    ['a file outside the allowed paths', { 'src/a.ts': 'a\nb\n' }],
    ['a line inserted mid-file', { '.factory/events/2026-10.jsonl': '{"z":0}\n{"a":1}\n' }],
    ['a binary file', { '.factory/ops/blob.bin': '\0\x01\x02' }],
    ['a .git* file', { '.factory/ops/.gitattributes': '* -diff\n' }],
  ])('refuses %s, whatever CI reports', (_name, files) => {
    const { repo, main } = project(base);
    const head = branch(repo, LOG, files);

    const result = mergeRules(input(repo, main, LOG, head));

    expect(result.rule).toBe('factory-log');
    expect(result.problems).not.toEqual([]);
  });

  it('refuses a symlink and an executable bit', () => {
    const { repo, main } = project(base);
    repo.checkout(LOG, { create: true });
    mkdirSync(join(repo.path, '.factory', 'ops'), { recursive: true });
    symlinkSync('/etc/passwd', join(repo.path, '.factory', 'ops', 'link'));
    writeFileSync(join(repo.path, '.factory', 'ops', 'run.sh'), 'echo\n');
    chmodSync(join(repo.path, '.factory', 'ops', 'run.sh'), 0o755);
    const head = repo.commit({}, 'link and script');
    repo.checkout('main');

    const problems = mergeRules(input(repo, main, LOG, head)).problems.join('\n');
    expect(problems).toContain('.factory/ops/link');
    expect(problems).toContain('.factory/ops/run.sh');
  });
});

describe('merge rules: other branches (T143)', () => {
  it.each(['feature/login', 'claude/other', 'claude/12-Bad_Slug', 'coach/2026-W41'])(
    'a project pull request from %s is refused',
    (name) => {
      const { repo, main } = project();
      const head = branch(repo, name, { 'src/b.ts': 'b\n' });

      expect(mergeRules(input(repo, main, name, head))).toEqual({
        rule: 'none',
        problems: [expect.stringMatching(/no merge rule/) as string],
      });
    },
  );
});

describe('merge rules: the factory repository (T143, FR-016g)', () => {
  it.each([
    ['git@github.com:BaltasarCampos/Factory01.git', FACTORY_REPO],
    ['ssh://git@github.com/BaltasarCampos/Factory01', FACTORY_REPO],
    ['https://github.com/BaltasarCampos/Factory01.git', FACTORY_REPO],
    ['https://x-access-token@github.com/BaltasarCampos/Factory01/', FACTORY_REPO],
    ['https://gitlab.com/BaltasarCampos/Factory01.git', undefined],
    ['/srv/git/Factory01.git', undefined],
  ])('normalises the origin %s', (url, repo) => {
    expect(originRepo(url)).toBe(repo);
  });

  it('reads the source repository the release names in its templates', () => {
    const factory = makeRepo({
      files: { 'factory/workflows/ci.yml': `env:\n  FACTORY_REPO: ${FACTORY_REPO}\n` },
    });
    expect(releaseSource(factory.path, factory.revParse('HEAD'))).toBe(FACTORY_REPO);
  });

  /** The factory repository before it adopts itself: no `.factory/config` on main. */
  function factoryRepo(origin = `git@github.com:${FACTORY_REPO}.git`) {
    const repo = makeRepo({
      files: { 'factory/self/ci.yml': 'old\n', 'src/a.ts': 'a\n' },
      signWith: owner,
    });
    repo.git(['remote', 'set-url', 'origin', origin]);
    return { repo, main: repo.revParse('main') };
  }

  it('before adoption, any branch merges under the factory-repository rule, factory/self/ included', () => {
    const { repo, main } = factoryRepo();
    const head = branch(repo, 'owner-work', { 'factory/self/ci.yml': 'new\n', 'src/b.ts': 'b\n' });

    expect(mergeRules(input(repo, main, 'owner-work', head))).toEqual({
      rule: 'factory-repository',
      problems: [],
    });
  });

  it.each([
    '.github/workflows/ci.yml',
    '.claude/settings.json',
    '.gitattributes',
    '.gitmodules',
    '.specify/memory/design.md',
    '.factory/config',
  ])('refuses %s there, which the Owner copies into place with a signed commit', (path) => {
    const { repo, main } = factoryRepo();
    const head = branch(repo, 'claude/7-fix', { [path]: 'changed\n' });

    const result = mergeRules(input(repo, main, 'claude/7-fix', head));

    expect(result.rule).toBe('factory-repository');
    expect(result.problems).toEqual([
      expect.stringMatching(new RegExp(`${path.replaceAll('.', '\\.')}.*signed commit`)) as string,
    ]);
  });

  it('a fork is a project: a branch the project rules do not know is refused', () => {
    const { repo, main } = factoryRepo('git@github.com:someone/Factory01.git');
    const head = branch(repo, 'owner-work', { 'src/b.ts': 'b\n' });

    expect(mergeRules(input(repo, main, 'owner-work', head)).rule).toBe('none');
  });

  it('after adoption, the project rules come first, and the factory-repository rule takes only the rest', () => {
    const { repo, main } = project();
    repo.git(['remote', 'set-url', 'origin', `https://github.com/${FACTORY_REPO}.git`]);
    const item = branch(repo, 'claude/12-login', { 'src/login.ts': 'export {};\n' });
    const coach = branch(repo, 'coach/2026-W41', { 'factory/roles/builder.md': 'x\n' });
    const other = branch(repo, 'claude/other', { 'src/b.ts': 'b\n' });

    expect(mergeRules(input(repo, main, 'claude/12-login', item))).toEqual({
      rule: 'item',
      problems: [],
      issue: 12,
    });
    expect(mergeRules(input(repo, main, 'coach/2026-W41', coach)).rule).toBe('factory-repository');
    expect(mergeRules(input(repo, main, 'claude/other', other)).rule).toBe('none');
  });
});

describe('merge rules: factory/upgrade-<tag> (T143, AC-083)', () => {
  const OLD = { '.claude/settings.json': 'old settings\n', '.github/workflows/ci.yml': 'old ci\n' };
  const NEW = { '.claude/settings.json': 'new settings\n', '.github/workflows/ci.yml': 'new ci\n' };

  interface Upgrade {
    /** Keys the new release's own allowed_signers lists. */
    releaseSigners?: TestKeys[];
    /** Who signs the release tag; `undefined` makes it unsigned. */
    tagKey?: TestKeys | 'unsigned';
    /** Main's pinned key lists, and the laptop's. */
    mainKeys?: ReleaseKeys;
    laptopKeys?: ReleaseKeys;
    /** The protected files the manifest lists. */
    manifest?: Record<string, string>;
    /** Files the upgrade branch commits besides the new config. */
    files?: Files;
    /** The new config; default main's with only the pin changed. */
    newConfig?: (pin: string) => string;
    branchTag?: string;
    waiver?: 'none' | 'other release';
    /** The tag is moved to a later commit after signing. */
    moved?: boolean;
    /** Changes made in the upgrade branch's work tree and committed after its files. */
    tamper?: (dir: string) => void;
    /** Main has no `.factory/config`. */
    noMainConfig?: boolean;
  }

  function upgrade(options: Upgrade = {}) {
    const factory = makeRepo({
      files: {
        allowed_signers: (options.releaseSigners ?? [owner])
          .map((k) => `${k.allowedSignersLine}\n`)
          .join(''),
        revoked_keys: '',
      },
    });
    const sha = factory.revParse('HEAD');
    const manifest = { ...manifestOf(options.manifest ?? NEW), release: 'v1.1.0', commit: sha };
    const message = serialiseManifest(manifest);
    const tagKey = options.tagKey ?? owner;
    if (tagKey === 'unsigned') factory.git(['tag', '-a', '-m', message, 'v1.1.0']);
    else
      factory.git([
        ...['-c', 'gpg.format=ssh', '-c', `user.signingkey=${tagKey.privateKey}`],
        ...['tag', '-s', '-m', message, 'v1.1.0'],
      ]);
    if (options.moved === true) {
      factory.commit({ 'later.txt': 'later\n' }, 'later');
      factory.git([
        ...['-c', 'gpg.format=ssh', '-c', `user.signingkey=${owner.privateKey}`],
        ...['tag', '-f', '-s', '-m', message, 'v1.1.0'],
      ]);
    }

    const { repo, main } = project({
      ...OLD,
      ...(options.noMainConfig === true ? { '.factory/config': null } : {}),
    });
    const pin = `v1.1.0@${sha}`;
    const name = `factory/upgrade-${options.branchTag ?? 'v1.1.0'}`;
    const newConfig = options.newConfig ?? ((p: string) => config(p));
    let head = branch(repo, name, {
      ...NEW,
      ...options.files,
      '.factory/config': newConfig(pin),
    });
    if (options.tamper !== undefined) {
      repo.checkout(name);
      options.tamper(repo.path);
      head = repo.commit({}, 'tamper');
      repo.checkout('main');
    }
    const waived = options.waiver === 'other release' ? `v1.2.0@${sha}` : pin;
    const record: ApprovalRecord = {
      ...{ repo: REPO, issue: PR, gate: 'waiver', branch: `factory/upgrade-v1.1.0` },
      ...{ waives: `check:guardrail-change@${waived}`, timestamp: AT },
      nonce: randomBytes(16).toString('hex'),
    };
    const body = renderComment(record, sign(record, owner.privateKey, { stdinIsTTY: true }));
    const pr: PullRequest = {
      number: PR,
      comments: options.waiver === 'none' ? [] : [{ id: '1', createdAt: AT, body }],
      labelAdds: options.waiver === 'none' ? [] : [{ label: 'owner:waiver', createdAt: LATER }],
    };
    return mergeRules(
      input(repo, main, name, head, {
        factory: factory.path,
        pr,
        ...(options.mainKeys === undefined ? {} : { keys: options.mainKeys }),
        ...(options.laptopKeys === undefined ? {} : { laptopKeys: options.laptopKeys }),
      }),
    );
  }

  it('accepts a signed release whose protected files match its manifest, with a verified waiver and only the pin changed', () => {
    expect(upgrade()).toEqual({ rule: 'upgrade', problems: [] });
  });

  it.each([
    ['unsigned', (): Upgrade => ({ tagKey: 'unsigned' }), /is not signed/],
    ['moved to another commit', (): Upgrade => ({ moved: true }), /does not point at the pinned/],
    ['signed by an unknown key', (): Upgrade => ({ tagKey: other }), /not signed by a listed/],
    [
      'signed by a key main revokes',
      (): Upgrade => ({ mainKeys: writeKeyFiles([owner], [owner]) }),
      /not signed by a listed, non-revoked/,
    ],
  ])('refuses a tag %s, even with a signed waiver', (_name, options, why) => {
    expect(upgrade(options()).problems.join('\n')).toMatch(why);
  });

  it("refuses a tag only the new release's own allowed_signers accepts", () => {
    const result = upgrade({ releaseSigners: [other, owner], tagKey: other });
    expect(result.problems.join('\n')).toMatch(/not signed by a listed, non-revoked/);
  });

  it("refuses a tag main's pinned lists accept but the laptop's own key lists do not", () => {
    const result = upgrade({
      tagKey: other,
      mainKeys: writeKeyFiles([other, owner]),
      laptopKeys: writeKeyFiles([owner]),
    });
    expect(result.problems).toEqual([
      expect.stringMatching(/laptop.*not signed by a listed, non-revoked/s) as string,
    ]);
  });

  it.each([
    [
      'a protected file missing',
      { manifest: { ...NEW, '.mcp.json': '{}\n' } },
      /missing \.mcp\.json/,
    ],
    ['an extra protected file', { files: { '.claude/hooks/x.sh': 'x\n' } }, /not in the release/],
    [
      'a changed protected file',
      { manifest: { ...NEW, '.claude/settings.json': 'other\n' } },
      /changed \.claude\/settings\.json/,
    ],
  ])('refuses %s against the manifest', (_name, options, why) => {
    expect(upgrade(options).problems.join('\n')).toMatch(why);
  });

  it('refuses a config change beyond the factory_release line', () => {
    const result = upgrade({ newConfig: (pin) => config(pin, 'retry_limit: 9\n') });
    expect(result.problems.join('\n')).toMatch(/\.factory\/config .*factory_release/);
  });

  it("refuses a branch whose tag is not the new pin's", () => {
    expect(upgrade({ branchTag: 'v1.2.0' }).problems.join('\n')).toMatch(
      /factory\/upgrade-v1\.2\.0 .* v1\.1\.0/,
    );
  });

  it('reads each path whole: a name with a tab cannot stand in for the file it starts with', () => {
    const settings = '.claude/settings.json';
    const result = upgrade({
      tamper: (dir) => {
        writeFileSync(join(dir, settings), 'tampered\n');
        writeFileSync(join(dir, `${settings}\tz`), NEW[settings]);
      },
    });
    expect(result.problems).toEqual(
      expect.arrayContaining([`changed ${settings}`, `not in the release: ${settings}\tz`]),
    );
  });

  it('refuses a symlink at a hashed path, even one whose target is the manifest content', () => {
    const settings = '.claude/settings.json';
    const result = upgrade({
      tamper: (dir) => {
        rmSync(join(dir, settings));
        symlinkSync(NEW[settings], join(dir, settings));
      },
    });
    expect(result.problems.join('\n')).toMatch(
      /\.claude\/settings\.json: not a regular file \(mode 120000\)/,
    );
  });

  it('reports a main without a readable .factory/config as a problem instead of throwing', () => {
    expect(upgrade({ noMainConfig: true }).problems.join('\n')).toMatch(
      /\.factory\/config on main/,
    );
  });

  it('refuses a change outside the protected set and .factory/config', () => {
    expect(upgrade({ files: { 'src/a.ts': 'changed\n' } }).problems.join('\n')).toMatch(
      /src\/a\.ts: outside the protected set/,
    );
  });

  it.each([
    ['no waiver', 'none' as const],
    ['a waiver for another release', 'other release' as const],
  ])('refuses %s', (_name, waiver) => {
    expect(upgrade({ waiver }).problems.join('\n')).toMatch(/check:guardrail-change@v1\.1\.0/);
  });
});

// `factory merge` itself, slice 22a: the checks before the merge, which ends every run with
// "the merge itself comes with slice 22b; nothing was merged" until slice 22b lands.
const ITEM = 7;
const ITEM_BRANCH = 'claude/7-add-login';
const ITEM_PR = 8;
const ITEM_SPEC = `# Add login

## Problem

Visitors cannot sign in.

1. **AC-001** — **Given** a user, **When** they sign in, **Then** they see their links.
`;
// Every check passed and the summary was shown; the Owner then answered no to the merge itself.
const DECLINED = 'the Owner did not confirm the merge; nothing was merged';
// The item's code and its tagged test: red at the base, where the code is missing, green at the head.
const LOGIN = 'export const login = (name: string) => name.length > 0;\n';
const VERIFY_REPORT = '| Check | Result |\n|---|---|\n| Review | pass |\n';
const SECURITY_REPORT = '## Scans\n\n- semgrep: none\n\n## Findings\n\n- none\n';
const LOGIN_TEST = [
  "import { expect, it } from 'vitest';",
  "import { login } from '../src/login.js';",
  "it('AC-001 signs in', () => { expect(login('ada')).toBe(true); });",
  '',
].join('\n');
const REQUIRED_PATH = 'factory/profiles/typescript/ci/required-checks.json';
const REQUIRED = loadRequiredChecks(
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
interface ActionsJob {
  /** The workflow file it ran from. */
  workflow: string;
  name: string;
  conclusion: string | null;
  attempt: number;
}
/** A job of the workflow run from `workflow`; `conclusion` null while it runs. */
const actionsJob = (
  workflow: string,
  name: string,
  conclusion: string | null,
  attempt = 1,
): ActionsJob => ({ workflow, name, conclusion, attempt });
const CI = '.github/workflows/ci.yml';
/** Every listed job green, from the workflow file it is installed at. */
const allGreen = (except: string[] = []) =>
  REQUIRED.jobs
    .filter((j) => !except.includes(j.job))
    .map((j) => actionsJob(j.installed, j.job, 'success'));
let nextRun = 5000;

/**
 * What GitHub Actions shows for `sha`: one pull_request workflow run per workflow file, with its
 * jobs over every attempt. By default every listed job is green.
 */
function actionsAt(sha: string, jobs: ActionsJob[] = allGreen(), earlierFailed: string[] = []) {
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
function pushRunAt(
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
const signersOf = (keys: TestKeys[]) => keys.map((k) => `${k.allowedSignersLine}\n`).join('');
const labeledAt = (name: string, at: string): FakeLabelEvent => ({
  event: 'labeled',
  label: { name },
  actor: { login: 'owner' },
  created_at: at,
});

interface MergeSetup {
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
interface Posted {
  comment: FakeComment;
  label?: FakeLabelEvent;
}

/** A record for the item, bound to its branch at tier 2 unless `fields` say otherwise. */
const itemRecord = (gate: ApprovalRecord['gate'], fields: Partial<ApprovalRecord> = {}) =>
  ({
    ...{ repo: REPO, issue: ITEM, gate, tier: 2, branch: ITEM_BRANCH },
    ...{ timestamp: '2026-10-01T08:00:00Z', nonce: randomBytes(16).toString('hex') },
    ...fields,
  }) as ApprovalRecord;

/** `record` signed with `keys`, posted at `at`, with its owner: label added a minute later. */
function posted(id: number, record: ApprovalRecord, at: string, keys = owner): Posted {
  const body = renderComment(record, sign(record, keys.privateKey, { stdinIsTTY: true }));
  const later = new Date(Date.parse(at) + 60_000).toISOString().replace('.000Z', 'Z');
  return {
    comment: { id, author: 'owner', body, createdAt: at },
    label: labeledAt(`owner:${record.gate}`, later),
  };
}

function mergeSetup(o: MergeSetup = {}) {
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

interface CliOver {
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

const ghCalls = () => calls().map((c) => c.join(' '));

describe(
  'factory merge: the checks before the merge (T068, slice 22a)',
  { timeout: 120_000 },
  () => {
    it('checks origin/<branch> as fetched, never the local branch, and merges nothing until slice 22b', async () => {
      const t = mergeSetup();
      t.repo.checkout(ITEM_BRANCH);
      const local = t.repo.commit({ 'src/local.ts': 'local\n' }, 'not pushed');
      t.repo.checkout('main');
      const before = t.mainOnOrigin();

      const r = await t.cli();

      expect(r.stderr).toContain(DECLINED);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(`origin/${ITEM_BRANCH} at ${t.head}`);
      expect(r.stdout).not.toContain(local);
      expect(r.stdout).toMatch(/rule item/);
      expect(t.mainOnOrigin()).toBe(before);
    });

    it('refuses when main has a first-parent commit not signed by the Owner, before reading the PR (AC-073)', async () => {
      const t = mergeSetup();
      t.repo.checkout('main');
      const unsigned = t.repo.commit({ 'src/b.ts': 'b\n' }, 'pushed past the Owner');
      t.repo.push('main');

      const r = await t.cli();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/not signed by the Owner/);
      expect(r.stderr).toContain(unsigned);
      expect(r.stderr).toContain('nothing was merged');
      expect(ghCalls().some((c) => c.startsWith('pr view'))).toBe(false);
    });

    it('approve and resume warn, naming the unsigned commit, and still use the keys at the last verified commit', async () => {
      const t = mergeSetup({ inbox: [labeledAt('pause:line', '2026-10-02T08:00:00Z')] });
      t.repo.checkout('main');
      const unsigned = t.repo.commit({ 'src/b.ts': 'b\n' }, 'pushed past the Owner');
      t.repo.push('main');

      const approved = await t.cli(['approve', String(ITEM), 'waiver', 'gate:plan']);
      const resumed = await t.cli(['resume']);

      for (const r of [approved, resumed]) {
        expect(r.code).toBe(0);
        expect(r.stderr).toMatch(/^warning: .*not signed by the Owner/m);
        expect(r.stderr).toContain(unsigned);
      }
    });

    it('refuses with "finish the rotation" when the signing key is not the newest at main\'s pin, before any slow step', async () => {
      const t = mergeSetup({ release: [owner, other] });

      const r = await t.cli();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/finish the rotation/);
      expect(ghCalls().some((c) => c.startsWith('pr view'))).toBe(false);
    });

    it('warns during a pause and goes on only after the Owner confirms (AC-078)', async () => {
      const t = mergeSetup({ inbox: [labeledAt('pause:line', '2026-10-02T08:00:00Z')] });

      const declined = await t.cli(['merge', String(ITEM_PR)], { answers: ['n'] });
      const confirmed = await t.cli(['merge', String(ITEM_PR)], { answers: ['y'] });

      expect(declined.code).toBe(1);
      expect(declined.stderr).toMatch(/warning: .*paused/);
      expect(declined.stderr).toContain('nothing was merged');
      expect(declined.stderr).not.toContain(DECLINED);
      // The pause, twice, and the merge itself once.
      expect(t.asked).toHaveLength(3);
      expect(confirmed.stderr).toContain(DECLINED);
    });

    it('warns while the dispatcher shows a session running for the item, and goes on only after the Owner confirms (AC-088)', async () => {
      const t = mergeSetup();
      t.repo.checkout(ITEM_BRANCH);
      const manifest = { item: ITEM, station: 4, role: 'builder', branch: ITEM_BRANCH };
      const tip = t.repo.commit(
        { 'specs/7-add-login/.station.json': `${JSON.stringify(manifest)}\n` },
        'Dispatcher: station 4 (builder) manifest',
      );
      t.repo.push(ITEM_BRANCH);
      t.repo.checkout('main');
      actionsAt(tip);

      const declined = await t.cli(['merge', String(ITEM_PR)], { answers: [''] });
      const confirmed = await t.cli(['merge', String(ITEM_PR)], { answers: ['yes'] });

      expect(declined.code).toBe(1);
      expect(declined.stderr).toMatch(/warning: .*session.*station 4/);
      expect(declined.stderr).not.toContain(DECLINED);
      expect(confirmed.stderr).toContain(DECLINED);
    });

    it('refuses an item main already has an Owner-signed Factory-Merge: #<issue> for (AC-088)', async () => {
      const t = mergeSetup({
        project: (repo) => {
          branch(repo, 'claude/7-old', { 'src/old.ts': 'old\n' });
          mergeIntoMain(repo, 'claude/7-old', `#${String(ITEM)}`, { signWith: owner });
        },
      });

      const r = await t.cli();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/#7 is already merged: .*Factory-Merge: #7/);
    });

    it('refuses an item with no verified owner:approved', async () => {
      const t = mergeSetup({ tier: null });

      const r = await t.cli();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/no verified owner:approved/);
    });

    it.each([
      ['a tier 3 item', { tier: 3 as const }],
      [
        'a pull request touching formal/',
        { files: { 'formal/line.tla': '---- MODULE line ----\n' } },
      ],
    ])('refuses %s: the formal check is not in this release (T165)', async (_, options) => {
      const t = mergeSetup(options);

      const r = await t.cli();

      expect(r.code).toBe(1);
      expect(r.stderr).toContain(NO_FORMAL);
      expect(r.stderr).not.toContain(DECLINED);
    });

    it("refuses what the branch's merge rule refuses, naming the rule", async () => {
      const t = mergeSetup({ files: { '.github/workflows/ci.yml': 'on: push\n' } });

      const r = await t.cli();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/item rule/);
      expect(r.stderr).toMatch(/\.github\/workflows\/ci\.yml: a protected path/);
    });

    it("after adoption, the factory repository's own branches merge under its rule, with factoryRepo from main's pin", async () => {
      // One setup at a time: each seeds the fake GitHub afresh.
      const factory = mergeSetup({ branch: 'owner-work' });
      const there = await factory.cli(['merge', String(ITEM_PR)], factory.asFactoryRepository());
      const elsewhere = await mergeSetup({ branch: 'owner-work' }).cli();

      expect(there.stdout).toMatch(/rule factory-repository/);
      expect(there.stderr).toContain(DECLINED);
      expect(elsewhere.stderr).toMatch(/no merge rule takes branch owner-work/);
    });

    it('in the factory repository before it adopts itself, says to sign merges by hand', async () => {
      const t = mergeSetup({ noConfig: true, branch: 'owner-work' });

      const r = await t.cli(['merge', String(ITEM_PR)], t.asFactoryRepository());

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/sign merges by hand until this repository adopts itself/);
    });

    it('in any other repository without .factory/config on main, says it is not a factory project', async () => {
      const t = mergeSetup({ noConfig: true, branch: 'owner-work' });

      const r = await t.cli();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(
        /no \.factory\/config on main: this is not a factory project; run factory new or factory adopt/,
      );
      expect(r.stderr).not.toMatch(/by hand/);
    });
    it.each([
      ['in a cloud session', { env: { CLAUDE_CODE_REMOTE: 'true' } }],
      ['without a terminal', { tty: false }],
    ])('refuses %s, before fetching anything', async (_, over: CliOver) => {
      const t = mergeSetup();

      const r = await t.cli(['merge', String(ITEM_PR)], over);

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/runs only on the Owner's laptop/);
      expect(existsSync(join(t.repo.path, '.git', 'FETCH_HEAD'))).toBe(false);
      expect(ghCalls()).toEqual([]);
    });

    it('refuses a pull request from a fork, even with the same branch name, before fetching its branch', async () => {
      const t = mergeSetup({ headRepository: 'someone/project' });
      const tracking = `refs/remotes/origin/${ITEM_BRANCH}`;
      t.repo.git(['update-ref', '-d', tracking]);

      const r = await t.cli();

      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        `#${String(ITEM_PR)} comes from a fork (someone/project); nothing was merged`,
      );
      expect(() => t.repo.revParse(tracking)).toThrow();
    });

    it('takes the tier from the verified approved record, never from the issue labels', async () => {
      const three = await mergeSetup({ tier: 3, labels: ['tier:1', 'owner:approved'] }).cli();
      const two = await mergeSetup({ tier: 2, labels: ['tier:3', 'owner:approved'] }).cli();

      expect(three.stderr).toContain(NO_FORMAL);
      expect(two.stderr).not.toContain(NO_FORMAL);
      expect(two.stderr).toContain(DECLINED);
    });

    it('counts Factory-Merge: only on first-parent merges: one reached through a second parent does not make the item merged', async () => {
      const t = mergeSetup({
        project: (repo) => {
          branch(repo, 'claude/9-other', { 'src/other.ts': 'other\n' });
          branch(repo, 'claude/7-side', { 'src/side.ts': 'side\n' });
          repo.checkout('claude/9-other');
          const message = 'Merge claude/7-side\n\nFactory-Merge: #7';
          repo.git(['merge', '-q', '--no-ff', '--no-gpg-sign', '-m', message, 'claude/7-side']);
          mergeIntoMain(repo, 'claude/9-other', '#9', { signWith: owner });
        },
      });
      const side = runGit(t.repo.origin, [
        'log',
        '--format=%H',
        '--grep=Factory-Merge: #7',
        'main',
      ]);

      const r = await t.cli();

      expect(side).toMatch(/^[0-9a-f]{40}$/);
      expect(r.stderr).not.toMatch(/already merged/);
      expect(r.stderr).toContain(DECLINED);
    });
  },
);

// Slice 22a-2: the whole approval chain at the checked head, its nonces, the criterion set, and
// re-signing a stale head-bound waiver through approve's own waiver flow.
const T_WAIVER = '2026-10-01T09:00:00Z';
const calcTests = (lines: string[]) =>
  [
    "import { expect, it } from 'vitest';",
    "import { add } from '../src/calc.js';",
    ...lines,
    '',
  ].join('\n');
const ADDS = "it('adds', () => { expect(add(1, 2)).toBe(3); });";
const WEAK = 'test:tests/calc.test.ts#adds';
const GROUNDLESS =
  'holds a record that does not verify and grants nothing; if you did not post it, delete it and run merge again';

/** The comments and label adds on the item now, as the verifier reads them. */
function itemThread() {
  const issue = readState().repos[REPO]?.issues.find((i) => i.number === ITEM);
  return {
    comments: (issue?.comments ?? []).map((c) => ({ ...c, id: String(c.id) })),
    labelAdds: (issue?.events ?? [])
      .filter((e) => e.event === 'labeled')
      .map((e) => ({ label: e.label.name, createdAt: e.created_at })),
  };
}

/**
 * An item whose branch skips a test that passed on main, with a waiver for it signed at the first
 * head; the branch then moves on (Integrate merges main), so the waiver is stale at the checked head.
 */
function staleWaiver(
  waives: string,
  movedFiles: Files = { 'src/extra.ts': 'export const extra = 1;\n' },
  weaken = true,
) {
  const t = mergeSetup({
    project: (repo) => {
      repo.commit(
        {
          'src/calc.ts': 'export const add = (a: number, b: number) => a + b;\n',
          'tests/calc.test.ts': calcTests([ADDS]),
        },
        'calc',
        { signWith: owner },
      );
      repo.push('main');
    },
    files: weaken ? { 'tests/calc.test.ts': calcTests([`it.skip${ADDS.slice(2)}`]) } : {},
    chain: ({ head }, standard) => [
      ...standard,
      posted(902, itemRecord('waiver', { waives, head }), T_WAIVER),
    ],
  });
  t.repo.checkout(ITEM_BRANCH);
  // Verify ran again on the moved head (T179), so its reports are current there.
  const reports = {
    'specs/7-add-login/reports/verify.md': `${VERIFY_REPORT}\nAfter the move.\n`,
    'specs/7-add-login/reports/security.md': `${SECURITY_REPORT}\nAfter the move.\n`,
  };
  const moved = t.repo.commit({ ...movedFiles, ...reports }, 'moved on');
  t.repo.push(ITEM_BRANCH);
  t.repo.checkout('main');
  actionsAt(moved);
  return { t, moved };
}

describe('factory merge: the approval chain (T068, slice 22a-2)', { timeout: 240_000 }, () => {
  it('at tier 2, refuses an item without a verified spec approval', async () => {
    const r = await mergeSetup({ chain: (_, standard) => standard.slice(0, 1) }).cli();

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/#7 has no verified owner:spec-approved/);
  });

  it('at tier 1, needs no spec approval', async () => {
    const r = await mergeSetup({ tier: 1 }).cli();

    expect(r.stderr).toContain(DECLINED);
  });

  it('refuses a spec changed since its approval, pointing to factory approve <issue> spec', async () => {
    const t = mergeSetup({
      chain: (_, [approved]) => [
        ...(approved === undefined ? [] : [approved]),
        posted(
          901,
          itemRecord('spec-approved', { spec_sha: 'b'.repeat(40) }),
          '2026-10-01T08:30:00Z',
        ),
      ],
    });

    const r = await t.cli();

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/spec\.md changed since it was approved.*factory approve 7 spec/);
  });

  it('refuses a tampered waiver, naming its comment', async () => {
    const t = mergeSetup({
      chain: (_, standard) => {
        const waiver = posted(903, itemRecord('waiver', { waives: 'gate:plan' }), T_WAIVER);
        const body = waiver.comment.body.replace('waives: gate:plan', 'waives: gate:tasks');
        return [...standard, { ...waiver, comment: { ...waiver.comment, body } }];
      },
    });

    const r = await t.cli();

    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`comment 903 ${GROUNDLESS}`);
  });

  it('refuses a record copied from another item, naming it', async () => {
    const t = mergeSetup({
      chain: (_, standard) => [
        posted(
          900,
          itemRecord('approved', { issue: 5, branch: 'claude/5-other' }),
          '2026-10-01T08:00:00Z',
        ),
        ...standard.slice(1),
      ],
    });

    const r = await t.cli();

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no verified owner:approved/);
    expect(r.stderr).toContain(`comment 900 ${GROUNDLESS}`);
  });

  it('refuses an owner:waiver label with no record behind it, saying to remove the label', async () => {
    const t = mergeSetup({
      chain: (_, standard) => [
        ...standard,
        {
          comment: { id: 904, author: 'owner', body: 'looks fine', createdAt: T_WAIVER },
          label: labeledAt('owner:waiver', '2026-10-01T09:01:00Z'),
        },
      ],
    });

    const r = await t.cli();

    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      'owner:waiver is on #7 with no waiver record behind it, so it grants nothing; if you did not add it, remove the label and run merge again',
    );
  });

  it('refuses two records in the chain sharing a nonce', async () => {
    const approved = itemRecord('approved');
    const t = mergeSetup({
      chain: ({ specBlob }) => [
        posted(900, approved, '2026-10-01T08:00:00Z'),
        posted(
          901,
          itemRecord('spec-approved', { spec_sha: specBlob, nonce: approved.nonce }),
          '2026-10-01T08:30:00Z',
        ),
      ],
    });

    const r = await t.cli();

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(new RegExp(`nonce ${approved.nonce}.*comment 900.*comment 901`));
  });

  it("refuses a record whose nonce the laptop's ledger saw on another comment", async () => {
    const approved = itemRecord('approved');
    const t = mergeSetup({
      chain: (_, standard) => [posted(900, approved, '2026-10-01T08:00:00Z'), ...standard.slice(1)],
    });
    new NonceLedger(nonceLedgerPath(t.home)).claim(approved.nonce, `${REPO}#5/77`);

    const r = await t.cli();

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/comment 900.*first seen on another comment/);
  });

  it('refuses a record whose owner: label was added before its comment', async () => {
    const t = mergeSetup({
      chain: (_, [approved, spec]) => [
        ...(approved === undefined ? [] : [approved]),
        ...(spec === undefined
          ? []
          : [{ ...spec, label: labeledAt('owner:spec-approved', '2026-10-01T08:29:00Z') }]),
      ],
    });

    const r = await t.cli();

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no verified owner:spec-approved.*comment 901/);
  });

  it.each([
    ['empty', '# Add login\n\n## Problem\n\nVisitors cannot sign in.\n', /no acceptance criteria/],
    [
      'with a criterion line without an ID',
      `${ITEM_SPEC}2. **Given** a guest, **When** they sign in, **Then** they are refused.\n`,
      /spec\.md:\d+: /,
    ],
  ])('refuses a checked set of acceptance criteria %s (AC-097)', async (_, spec, why) => {
    const r = await mergeSetup({ files: { 'specs/7-add-login/spec.md': spec } }).cli();

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(why);
  });

  it('a stale gate: waiver approve would refuse to sign does not count, and the check decides', async () => {
    const { t, moved } = staleWaiver('gate:red-green', undefined, false);

    // No re-sign question comes: approve refuses before asking.
    const r = await t.cli();

    expect(r.stdout).toMatch(/no red-green check yet/);
    expect(r.stdout).toContain(
      `the waiver for gate:red-green is not re-signed, so it does not count at ${moved}; the check decides`,
    );
    expect(r.stderr).toContain(DECLINED);
  });

  it('skips a stale test: waiver that covers nothing at the checked head, without asking', async () => {
    const { t, moved } = staleWaiver(WEAK, { 'tests/calc.test.ts': calcTests([ADDS]) });

    const r = await t.cli();

    expect(r.stdout).toContain(
      `the waiver for ${WEAK} covers nothing at ${moved}; no longer needed`,
    );
    expect(t.asked.filter((q) => q.startsWith('Sign a new waiver'))).toEqual([]);
    expect(r.stderr).toContain(DECLINED);
  });

  it('a declined re-sign of a stale test: waiver refuses the merge and signs nothing', async () => {
    const { t } = staleWaiver(WEAK);
    const before = itemThread().comments.length;

    const r = await t.cli(['merge', String(ITEM_PR)], { answers: ['n'] });

    expect(r.code).toBe(1);
    expect(r.stdout).toContain('diff since the waived head');
    // Not re-signed, so it does not count, and the weakened check decides.
    expect(r.stderr).toContain(`${WEAK}: passed at the base, skipped at the head; covered by none`);
    expect(itemThread().comments).toHaveLength(before);
  });

  it('re-signs a stale test: waiver at the checked head with a fresh owner:waiver, and the new record verifies', async () => {
    const { t, moved } = staleWaiver(WEAK);

    const r = await t.cli(['merge', String(ITEM_PR)], { answers: ['y'] });

    expect(r.stdout).toContain('diff since the waived head');
    expect(r.stdout).toContain(WEAK);
    expect(r.stderr).toContain(DECLINED);
    const verdict = verifyGate({
      ...{ keys: writeKeyFiles([owner]), secondCopy: owner.publicKey, ...itemThread() },
      expected: {
        ...{ repo: REPO, issue: ITEM, gate: 'waiver', tier: 2, branch: ITEM_BRANCH },
        ...{ waives: WEAK, head: moved },
      },
    });
    expect(verdict.ok).toBe(true);
  });
});

// Slice 22a-3: CI from GitHub Actions check runs on the checked head, the required jobs from the
// release, and the laptop's own sandboxed weakened, ac-map and red-green runs.
describe(
  'factory merge: CI and the laptop checks (T068, slice 22a-3)',
  { timeout: 240_000 },
  () => {
    it('passes an item whose required jobs are green and whose laptop checks pass', async () => {
      const r = await mergeSetup().cli();

      expect(r.stdout).toMatch(/CI: \d+ required jobs green at /);
      expect(r.stdout).toContain('weakened: no test weakened');
      expect(r.stdout).toContain('ac-map: every checked criterion has a passing test');
      expect(r.stdout).toMatch(/red-green: 1 criterion goes from failing to passing/);
      expect(r.stderr).toContain(DECLINED);
    });

    it('counts only runs of the workflow file a job is installed at: not a commit status, not another workflow file', async () => {
      const t = mergeSetup();
      actionsAt(t.head, [
        ...allGreen(['build-test']),
        actionsJob('.github/workflows/other.yml', 'build-test', 'success'),
      ]);
      const state = readState();
      const repo = state.repos[REPO];
      if (repo !== undefined)
        repo.api[`repos/${REPO}/commits/${t.head}/status`] = {
          state: 'success',
          statuses: [{ context: 'ci / build-test', state: 'success' }],
        };
      writeFileSync(process.env.FAKE_GH_STATE ?? '', JSON.stringify(state));

      const r = await t.cli();

      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`build-test (${CI}): missing`);
      expect(ghCalls().some((c) => c.includes('/status'))).toBe(false);
    });

    it('a failed build-test is not hidden by a later green build-test from another workflow file', async () => {
      const t = mergeSetup();
      actionsAt(t.head, [
        ...allGreen(['build-test']),
        actionsJob(CI, 'build-test', 'failure'),
        actionsJob('.github/workflows/factory-self.yml', 'build-test', 'success'),
      ]);

      const r = await t.cli();

      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`build-test (${CI}): failure`);
    });

    it('refuses a required job pending, failed, cancelled or skipped, naming each', async () => {
      const t = mergeSetup();
      const state: Record<string, string | null> = {
        'build-test': null,
        coverage: 'failure',
        'ac-map': 'cancelled',
        'red-green': 'skipped',
      };
      actionsAt(t.head, [
        ...allGreen(Object.keys(state)),
        ...Object.entries(state).map(([job, conclusion]) => actionsJob(CI, job, conclusion)),
      ]);

      const r = await t.cli();

      expect(r.code).toBe(1);
      for (const line of [
        'build-test (.github/workflows/ci.yml): pending',
        'coverage (.github/workflows/ci.yml): failure',
        'ac-map (.github/workflows/ci.yml): cancelled',
        'red-green (.github/workflows/ci.yml): skipped',
      ])
        expect(r.stderr).toContain(line);
    });

    it('lets the latest attempt of a job decide: green after a failed attempt passes, failed after green does not', async () => {
      const t = mergeSetup();
      const rest = allGreen(['build-test']);
      actionsAt(t.head, [
        ...rest,
        actionsJob(CI, 'build-test', 'failure', 1),
        actionsJob(CI, 'build-test', 'success', 2),
      ]);
      const rerun = await t.cli();
      actionsAt(t.head, [
        ...rest,
        actionsJob(CI, 'build-test', 'success', 1),
        actionsJob(CI, 'build-test', 'failure', 2),
      ]);
      const broken = await t.cli();

      expect(rerun.stderr).toContain(DECLINED);
      expect(broken.stderr).toContain(`build-test (${CI}): failure`);
    });

    it('requires append-only when the pull request changes an events.jsonl', async () => {
      const t = mergeSetup({ files: { 'specs/7-add-login/events.jsonl': '{"kind":"usage"}\n' } });
      actionsAt(t.head, allGreen(['append-only']));

      const r = await t.cli();

      expect(r.code).toBe(1);
      expect(r.stderr).toContain('append-only (.github/workflows/append-only.yml): missing');
    });

    it('refuses a weakened test with no test: waiver in force at the checked head', async () => {
      const t = mergeSetup({
        project: (repo) => {
          repo.commit(
            {
              'src/calc.ts': 'export const add = (a: number, b: number) => a + b;\n',
              'tests/calc.test.ts': calcTests([ADDS]),
            },
            'calc',
            { signWith: owner },
          );
          repo.push('main');
        },
        files: { 'tests/calc.test.ts': calcTests([`it.skip${ADDS.slice(2)}`]) },
      });

      const r = await t.cli();

      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        `${WEAK}: passed at the base, skipped at the head; covered by none`,
      );
    });

    it('refuses a checked criterion no passing test names (ac-map)', async () => {
      const untagged = LOGIN_TEST.replace('AC-001 signs in', 'signs in');
      const r = await mergeSetup({ files: { 'tests/login.test.ts': untagged } }).cli();

      expect(r.code).toBe(1);
      expect(r.stderr).toContain('AC-001: no passing test names it');
    });

    it('refuses a tagged test that already passes at the base (red-green)', async () => {
      const t = mergeSetup({
        project: (repo) => {
          repo.commit({ 'src/login.ts': LOGIN }, 'login', { signWith: owner });
          repo.push('main');
        },
        files: { 'src/login.ts': `${LOGIN}export const logout = () => true;\n` },
      });

      const r = await t.cli();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/red-green fails at .*AC-001/s);
    });

    it('says when red-green skipped a tests-only item, and goes on', async () => {
      const t = mergeSetup({
        project: (repo) => {
          repo.commit({ 'src/login.ts': LOGIN }, 'login', { signWith: owner });
          repo.push('main');
        },
        files: { 'src/login.ts': LOGIN },
      });

      const r = await t.cli();

      expect(r.stdout).toContain('red-green skipped: only test code changed');
      expect(r.stderr).toContain(DECLINED);
    });
  },
);

// Slice 22a-4: the item's merge summary, from what the checks found, with nothing run again.
describe(
  'factory merge: the item summary (T068, slice 22a-4, AC-094)',
  { timeout: 240_000 },
  () => {
    it('shows the summary: diffstat, every changed test file even at net zero, criteria to tests, CI, the verify report', async () => {
      const t = mergeSetup({
        project: (repo) => {
          repo.commit(
            {
              'src/calc.ts': 'export const add = (a: number, b: number) => a + b;\n',
              'tests/calc.test.ts': calcTests([ADDS]),
            },
            'calc',
            { signWith: owner },
          );
          repo.push('main');
        },
        files: { 'tests/calc.test.ts': calcTests([ADDS.replace('toBe(3)', 'toBe(1 + 2)')]) },
      });
      actionsAt(t.head, allGreen(), [CI]);

      const r = await t.cli();

      expect(r.stdout).toContain(`Approval summary for #7 (merge) at ${t.head}:`);
      for (const line of [
        'modified +1 -1 tests/calc.test.ts',
        'Changed test files (each listed, even when its counts net to zero):',
        'AC-001 → AC-001 signs in',
        'build-test (.github/workflows/ci.yml): success; 1 earlier run failed',
        'reports/verify.md: the review passes',
        `quoted from specs/7-add-login/reports/security.md written at ${t.head.slice(0, 12)}:`,
        '> - semgrep: none',
        'Waivers in force: none',
      ])
        expect(r.stdout).toContain(line);
      expect(r.stderr).toContain(DECLINED);
    });

    it('refuses when a required part is missing: no verify report', async () => {
      const r = await mergeSetup({ files: { 'specs/7-add-login/reports/verify.md': null } }).cli();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(
        /not merging: the approval summary is incomplete:\n\s+Tests and review: /,
      );
    });

    it('T179: a verify report a later commit made stale counts as missing, naming both commits', async () => {
      const t = mergeSetup({ then: [{ 'src/login.ts': `${LOGIN}// later\n` }] });
      const wrote = t.repo.git(['rev-parse', `${t.head}~1`]);

      const r = await t.cli();

      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        `reports/verify.md written at ${wrote.slice(0, 12)} is stale: ${t.head.slice(0, 12)} came after it, so Verify must run again`,
      );
    });

    it('T179: at tier 2 a missing or stale security report refuses; at tier 1 none is needed', async () => {
      const security = 'specs/7-add-login/reports/security.md';
      const none = await mergeSetup({ files: { [security]: null } }).cli();
      expect(none.code).toBe(1);
      expect(none.stderr).toContain(
        'no reports/security.md on claude/7-add-login, which tier 2 needs',
      );

      const stale = await mergeSetup({
        then: [
          { 'src/login.ts': `${LOGIN}// later\n` },
          { 'specs/7-add-login/reports/verify.md': `${VERIFY_REPORT}\n` },
        ],
      }).cli();
      expect(stale.code).toBe(1);
      expect(stale.stderr).toMatch(
        /reports\/security\.md written at \w{12} is stale: \w{12} came after it/,
      );

      const one = await mergeSetup({ tier: 1, files: { [security]: null } }).cli();
      expect(one.stderr).not.toContain('reports/security.md');
    });

    it('refuses an upgrade pull request until slice 35', async () => {
      const r = await mergeSetup({ branch: 'factory/upgrade-v1.1.0' }).cli();

      expect(r.code).toBe(1);
      expect(r.stderr).toContain('upgrade merges come with slice 35 (T115); nothing was merged');
    });
  },
);

// Slice 22b: the signed merge of a work item, made with git commit-tree, never a checkout.
const PULL_HINT = 'run git pull --ff-only to update your checkout';

/** Change the item's pull request as GitHub holds it. */
function onPr(change: (pr: FakePr) => void) {
  const state = readState();
  const pr = state.repos[REPO]?.prs.find((p) => p.number === ITEM_PR);
  if (pr === undefined) throw new Error('no pull request');
  change(pr);
  writeFileSync(process.env.FAKE_GH_STATE ?? '', JSON.stringify(state));
}

/** A commit pushed to `branch` on origin from the project clone, signed by the Owner. */
function pushTo(repo: TestRepo, branch: string, file: string): string {
  repo.checkout(branch);
  const sha = repo.commit({ [file]: `${file}\n` }, `more on ${branch}`, { signWith: owner });
  repo.push(branch);
  repo.checkout('main');
  return sha;
}

describe(
  'factory merge: the signed merge of a work item (T068, slice 22b)',
  { timeout: 240_000 },
  () => {
    it('merges exactly the checked head with a commit-tree signed merge, deletes the branch, and touches no working copy (AC-014)', async () => {
      const t = mergeSetup();
      const before = t.mainOnOrigin();
      const local = {
        head: t.repo.revParse('HEAD'),
        branch: t.repo.git(['branch', '--show-current']),
      };

      const r = await t.cli(['merge', String(ITEM_PR)], { answers: ['y'] });

      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(t.asked.at(-1)).toBe(`Merge #${String(ITEM_PR)} into main? [y/N] `);
      expect(r.stdout).toContain(PULL_HINT);
      const merged = t.mainOnOrigin();
      expect(
        runGit(t.repo.origin, ['rev-list', '--parents', '-n', '1', merged]).split(' ').slice(1),
      ).toEqual([before, t.head]);
      expect(runGit(t.repo.origin, ['rev-parse', `${merged}^{tree}`])).toBe(
        runGit(t.repo.origin, ['rev-parse', `${t.head}^{tree}`]),
      );
      expect(runGit(t.repo.origin, ['log', '-1', '--format=%B', merged])).toMatch(
        /\nFactory-Merge: #7\n?$/,
      );
      const keys = writeKeyFiles([owner]);
      runGit(t.repo.origin, [
        ...[
          '-c',
          `gpg.ssh.allowedSignersFile=${keys.allowedSigners}`,
          '-c',
          'gpg.minTrustLevel=fully',
        ],
        ...['verify-commit', merged],
      ]);
      expect(() =>
        runGit(t.repo.origin, ['rev-parse', '--verify', `refs/heads/${ITEM_BRANCH}`]),
      ).toThrow();
      // Nothing of the Owner's working copy moved.
      expect(t.repo.revParse('HEAD')).toBe(local.head);
      expect(t.repo.git(['branch', '--show-current'])).toBe(local.branch);
      expect(t.repo.git(['status', '--porcelain'])).toBe('');
    });

    it('refuses an item whose branch is behind main, before any slow step, with nothing pushed', async () => {
      const t = mergeSetup();
      const moved = pushTo(t.repo, 'main', 'src/later.ts');

      const r = await t.cli(['merge', String(ITEM_PR)], { answers: ['y'] });

      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        `main moved since #${String(ITEM_PR)} was integrated; Integrate must merge main again before it can merge; nothing was merged`,
      );
      expect(r.stdout).not.toContain('weakened:');
      expect(t.mainOnOrigin()).toBe(moved);
      expect(runGit(t.repo.origin, ['rev-parse', `refs/heads/${ITEM_BRANCH}`])).toBe(t.head);
    });

    it('aborts with nothing merged when main moves between the check and the push', async () => {
      const t = mergeSetup();
      const checked = t.mainOnOrigin();
      let moved = '';

      const r = await t.cli(['merge', String(ITEM_PR)], {
        answers: [() => ((moved = pushTo(t.repo, 'main', 'src/race.ts')), 'y')],
      });

      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`main moved since ${checked}`);
      expect(r.stderr).toContain('nothing was merged');
      expect(t.mainOnOrigin()).toBe(moved);
      expect(runGit(t.repo.origin, ['rev-parse', `refs/heads/${ITEM_BRANCH}`])).toBe(t.head);
    });

    it('the lease refuses a main rewound to an older commit, which our merge would otherwise fast-forward', async () => {
      const t = mergeSetup();
      const checked = t.mainOnOrigin();
      const older = runGit(t.repo.origin, ['rev-parse', `${checked}^`]);

      const r = await t.cli(['merge', String(ITEM_PR)], {
        answers: [() => (runGit(t.repo.origin, ['update-ref', 'refs/heads/main', older]), 'y')],
      });

      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`main moved since ${checked}`);
      expect(t.mainOnOrigin()).toBe(older);
    });

    it("gives git's own reason when the push is refused and main did not move", async () => {
      const t = mergeSetup();
      const before = t.mainOnOrigin();
      const hook = join(t.repo.origin, 'hooks', 'pre-receive');
      writeFileSync(hook, '#!/bin/sh\necho "denied by repository policy" >&2\nexit 1\n', {
        mode: 0o755,
      });

      const r = await t.cli(['merge', String(ITEM_PR)], { answers: ['y'] });

      expect(r.code).toBe(1);
      expect(r.stderr).toContain('denied by repository policy');
      expect(r.stderr).toContain('nothing was merged');
      expect(r.stderr).not.toContain('main moved');
      expect(t.mainOnOrigin()).toBe(before);
    });

    it('verifies the merge commit with the keys pinned at main before pushing', async () => {
      // The release pinned on main lists the Owner's key for records only, not for git: the
      // newest-key check passes, and git verify-commit, as the next walk runs it, would not.
      const recordsOnly = owner.allowedSignersLine.replace(
        '"factory-approve,git"',
        '"factory-approve"',
      );
      const t = mergeSetup({ nextRelease: `${recordsOnly}\n` });
      const before = t.mainOnOrigin();

      const r = await t.cli(['merge', String(ITEM_PR)], { answers: ['y'] });

      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        'your signing key is not accepted by the release pinned on main; nothing was pushed',
      );
      expect(t.mainOnOrigin()).toBe(before);
    });

    it.each([
      ['closes the pull request with a comment naming the merged commit', 'OPEN' as const],
      ['copes with a pull request GitHub already closed', 'CLOSED' as const],
    ])(
      'a head pushed after the check is not merged, the branch is deleted, and merge %s (AC-088)',
      async (_, state) => {
        const t = mergeSetup();
        let pushed = '';

        const r = await t.cli(['merge', String(ITEM_PR)], {
          answers: [
            () => {
              pushed = pushTo(t.repo, ITEM_BRANCH, 'src/late.ts');
              onPr((pr) => {
                pr.headRefOid = pushed;
                pr.state = state;
              });
              return 'y';
            },
          ],
        });

        expect(r.code).toBe(0);
        const merged = t.mainOnOrigin();
        expect(runGit(t.repo.origin, ['rev-parse', `${merged}^2`])).toBe(t.head);
        expect(() =>
          runGit(t.repo.origin, ['rev-parse', '--verify', `refs/heads/${ITEM_BRANCH}`]),
        ).toThrow();
        const pr = readState().repos[REPO]?.prs.find((p) => p.number === ITEM_PR);
        expect(pr?.state).toBe('CLOSED');
        expect(pr?.comments.at(-1)?.body).toContain(merged);
        expect(pr?.comments.at(-1)?.body).toContain(pushed);
      },
    );
  },
);

// Slice 22c: Define, log and factory-repository branches may be behind main, so what lands is
// git's merge of the two, checked on an unsigned probe commit before the prompt.
const LOG_BRANCH = 'claude/factory-log';
const SEEDS = [2, 3, 4, 5, 6];
const BRIEF = `# Brief

## Problem
Saving links across devices is clumsy. [pitch]

## Users
The Owner, on a phone and a laptop. [answer:Q1]

## Core use cases
- Save a link with one tap. [pitch]

## Non-goals
- Sharing links with other people. [answer:Q1]

## Success measures
- A link is saved in under 5 seconds. [pitch]

## Risk areas
- None known yet. [pitch]
`;
/** A complete Define run: questions, then the Owner's answers, then the outputs. */
const DEFINE_RUN: Files[] = [
  { '.factory/define/questions.md': 'Q1. Who uses it?\n' },
  { '.factory/define/answers.md': 'A1. Only me.\n' },
  {
    '.factory/brief.md': BRIEF,
    'package.json': '{ "scripts": { "test": "vitest run" } }\n',
    'tests/health.test.ts': "it('answers /health', () => {});\n",
    '.factory/define/backlog.md': `# Backlog\n\n${SEEDS.map((n) => `- #${String(n)} Seed ${String(n)}`).join('\n')}\n`,
  },
];
const seed = (number: number, body = `${SEED_MARKER}\nA seed issue.\n`) => ({
  ...{ number, title: `Seed ${String(number)}`, body, labels: ['tier:2'] },
});
const DEFINE: MergeSetup = {
  branch: 'claude/define',
  noBrief: true,
  commits: DEFINE_RUN,
  issues: SEEDS.map((n) => seed(n)),
  pr: { isDraft: true, title: 'Define: brief and backlog' },
};
const MERGE_PROMPT = `Merge #${String(ITEM_PR)} into main? [y/N] `;
const merged = (repo: TestRepo, ref = 'main') => ({
  parents: runGit(repo.origin, ['rev-list', '--parents', '-n', '1', ref]).split(' ').slice(1),
  message: runGit(repo.origin, ['log', '-1', '--format=%B', ref]),
});
const branchOnOrigin = (repo: TestRepo, name: string) =>
  runGit(repo.origin, ['rev-parse', '--verify', `refs/heads/${name}`]);
/** `files` committed on main by the Owner and pushed; returns the new head. */
function onMain(repo: TestRepo, files: Files, message: string, edit?: () => void): string {
  repo.checkout('main');
  edit?.();
  const sha = repo.commit(files, message, { signWith: owner });
  repo.push('main');
  return sha;
}
const briefCounts = (repo: TestRepo) => {
  repo.git(['fetch', '-q', 'origin']);
  return briefMerged(verifiedMerges(repo.path, () => writeKeyFiles([owner]), { env: gitEnv }));
};

describe(
  'factory merge: Define, log and factory-repository branches (T068, slice 22c)',
  { timeout: 240_000 },
  () => {
    it('merges a complete Define run with Factory-Merge: define, keeps claude/define, and the brief then counts as merged (AC-006)', async () => {
      const t = mergeSetup(DEFINE);
      const before = t.mainOnOrigin();
      const unmerged = briefCounts(t.repo);

      const r = await t.cli(['merge', String(ITEM_PR)], { answers: ['y'] });

      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/rule define/);
      expect(r.stdout).toContain('Define output check');
      expect(r.stdout).toContain('changed by the merge result against main (what lands)');
      expect(t.asked.at(-1)).toBe(MERGE_PROMPT);
      const m = merged(t.repo);
      expect(m.parents).toEqual([before, t.head]);
      expect(m.message).toMatch(/\nFactory-Merge: define\n?$/);
      expect(branchOnOrigin(t.repo, 'claude/define')).toBe(t.head);
      expect(unmerged).toBe(false);
      expect(briefCounts(t.repo)).toBe(true);
    });

    it('merges a Define run after a config set commit landed on main: merge-tree, then the path check on the result (Gate A)', async () => {
      const t = mergeSetup(DEFINE);
      const config = `${runGit(t.repo.path, ['show', 'main:.factory/config'])}\nretry_limit: 3\n`;
      const moved = onMain(
        t.repo,
        { '.factory/config': config },
        'factory config set retry_limit 3',
      );

      const r = await t.cli(['merge', String(ITEM_PR)], { answers: ['y'] });

      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Main moved since the branch was cut');
      const m = merged(t.repo);
      expect(m.parents).toEqual([moved, t.head]);
      expect(runGit(t.repo.origin, ['show', 'main:.factory/config'])).toContain('retry_limit: 3');
      expect(runGit(t.repo.origin, ['show', 'main:.factory/brief.md'])).toBe(BRIEF.trimEnd());
      // The probe: unsigned, made by factory probe, never pushed and named by no ref.
      const unreachable = runGit(t.repo.path, ['fsck', '--no-reflogs', '--unreachable'])
        .split('\n')
        .flatMap((l) => /^unreachable commit ([0-9a-f]+)$/.exec(l)?.slice(1) ?? []);
      const probes = unreachable.map((sha) =>
        runGit(t.repo.path, ['log', '-1', '--format=%an <%ae>|%cn <%ce>|%G?|%P|%T', sha]),
      );
      const tree = runGit(t.repo.origin, ['rev-parse', 'main^{tree}']);
      expect(probes).toEqual([
        `factory probe <probe@invalid>|factory probe <probe@invalid>|N|${moved} ${t.head}|${tree}`,
      ]);
      for (const repo of [t.repo.path, t.repo.origin])
        expect(runGit(repo, ['log', '--all', '--format=%an'])).not.toContain('factory probe');
    });

    it.each([
      [
        'a seed issue without the seed marker',
        { issues: SEEDS.map((n) => (n === 4 ? seed(n, 'no marker\n') : seed(n))) },
        `#4: no ${SEED_MARKER} marker`,
      ],
      [
        "a run still waiting for the Owner's answers",
        { commits: DEFINE_RUN.slice(0, 1) },
        "waiting for the Owner's answers",
      ],
    ])(
      'refuses a Define run with %s, naming what is missing, before the prompt',
      async (_, over, why) => {
        const t = mergeSetup({ ...DEFINE, ...over });
        const before = t.mainOnOrigin();

        const r = await t.cli(['merge', String(ITEM_PR)], { answers: ['y'] });

        expect(r.code).toBe(1);
        expect(r.stderr).toContain(why);
        expect(r.stderr).toContain('nothing was merged');
        expect(t.asked).not.toContain(MERGE_PROMPT);
        expect(t.mainOnOrigin()).toBe(before);
      },
    );

    it('merges claude/factory-log after main moved, with Factory-Merge: factory-log, and keeps the branch', async () => {
      const t = mergeSetup({
        branch: LOG_BRANCH,
        commits: [{ '.factory/events/2026-10.jsonl': '{"a":1}\n' }],
      });
      const moved = onMain(t.repo, { 'src/later.ts': 'later\n' }, 'later work');

      const r = await t.cli(['merge', String(ITEM_PR)], { answers: ['y'] });

      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/rule factory-log/);
      const m = merged(t.repo);
      expect(m.parents).toEqual([moved, t.head]);
      expect(m.message).toMatch(/\nFactory-Merge: factory-log\n?$/);
      expect(branchOnOrigin(t.repo, LOG_BRANCH)).toBe(t.head);
    });

    it('refuses a log merge whose result leaves the log paths, though the branch alone stays inside them', async () => {
      // Main renamed the file the log branch appends to; git's merge carries the append along.
      const t = mergeSetup({
        branch: LOG_BRANCH,
        project: (repo) => onMain(repo, { '.factory/ops/notes.md': 'notes\n' }, 'ops notes'),
        commits: [{ '.factory/ops/notes.md': 'notes\nmore\n' }],
      });
      const moved = onMain(t.repo, {}, 'move the notes', () =>
        t.repo.git(['mv', '.factory/ops/notes.md', 'notes.md']),
      );

      const r = await t.cli(['merge', String(ITEM_PR)], { answers: ['y'] });

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/factory-log rule refuses the merge result/);
      expect(r.stderr).toContain('notes.md: outside the log paths');
      expect(t.asked).not.toContain(MERGE_PROMPT);
      expect(t.mainOnOrigin()).toBe(moved);
    });

    it('refuses a branch that conflicts with main, naming the file, with nothing pushed', async () => {
      const t = mergeSetup({
        branch: LOG_BRANCH,
        project: (repo) =>
          onMain(repo, { '.factory/events/2026-10.jsonl': '{"a":1}\n' }, 'first events'),
        commits: [{ '.factory/events/2026-10.jsonl': '{"a":1}\n{"b":2}\n' }],
      });
      const moved = onMain(
        t.repo,
        { '.factory/events/2026-10.jsonl': '{"a":1}\n{"c":3}\n' },
        'events from elsewhere',
      );

      const r = await t.cli(['merge', String(ITEM_PR)], { answers: ['y'] });

      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        `#${String(ITEM_PR)} conflicts with main in .factory/events/2026-10.jsonl`,
      );
      expect(r.stderr).toContain('nothing was merged');
      expect(t.asked).not.toContain(MERGE_PROMPT);
      expect(t.mainOnOrigin()).toBe(moved);
      expect(branchOnOrigin(t.repo, LOG_BRANCH)).toBe(t.head);
    });

    it("merges the factory repository's own branch with Factory-Merge: branch <name> and deletes it", async () => {
      const t = mergeSetup({ branch: 'owner-work' });
      const before = t.mainOnOrigin();

      const r = await t.cli(['merge', String(ITEM_PR)], {
        ...t.asFactoryRepository(),
        answers: ['y'],
      });

      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      const m = merged(t.repo);
      expect(m.parents).toEqual([before, t.head]);
      expect(m.message).toMatch(/\nFactory-Merge: branch owner-work\n?$/);
      expect(() => branchOnOrigin(t.repo, 'owner-work')).toThrow();
    });
  },
);

// Slices 23a and 23b-2a: `factory deploy` exports main's verified commit into a new release folder,
// builds it in two bubblewrap runs, the install with network and the build without, then switches
// the app's systemd user unit to it, here with a fake `systemctl --user` that serves the unit's
// port when its release holds a file `serves`.
const LOCK = {
  ...{ name: 'p', version: '1.0.0', lockfileVersion: 3, requires: true },
  packages: { '': { name: 'p', version: '1.0.0' } },
};
/**
 * The product on main: an empty install, `build` as its build script, and whether it serves; a
 * string is what its `/health` answers with a 503, else it answers 200 `{"status":"ok"}`.
 */
const product = (build: string, serves: boolean | string = true): Files => ({
  'package.json': JSON.stringify({ name: 'p', version: '1.0.0', scripts: { build } }),
  'package-lock.json': JSON.stringify(LOCK),
  'build.mjs':
    "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('dist');\nwriteFileSync('dist/out.txt', 'built');\n",
  ...(serves === false ? {} : { serves: serves === true ? '' : serves }),
});
const releasesOf = (home: string) => {
  const { releases } = appFolder(home, REPO);
  return existsSync(releases) ? readdirSync(releases).map((n) => join(releases, n)) : [];
};
/** A bwrap first on PATH whose probe fails as it does without user namespaces. */
function failingBwrap(): NodeJS.ProcessEnv {
  const bin = tempDir();
  writeFileSync(
    join(bin, 'bwrap'),
    '#!/bin/sh\necho "bwrap: No permissions to create new namespace" >&2\nexit 1\n',
  );
  chmodSync(join(bin, 'bwrap'), 0o755);
  return { PATH: `${bin}:${systemd.PATH}` };
}
const systemd = {
  PATH: `${join(fileURLToPath(new URL('../helpers/systemd', import.meta.url)))}:${process.env.PATH ?? ''}`,
};
let nextPort = 23_000 + (process.pid % 2_000) * 4;

/** A project ready to deploy: main holds the product and its port; the settings file is there. */
function deployable(files: Files, o: MergeSetup = {}) {
  const t = mergeSetup(o);
  const port = nextPort++;
  const config = `${runGit(t.repo.path, ['show', 'main:.factory/config'])}\napp_port: ${String(port)}\n`;
  const main = onMain(t.repo, { ...files, '.factory/config': config }, 'the product');
  const app = appFolder(t.home, REPO);
  mkdirSync(join(app.settings, '..'), { recursive: true });
  writeFileSync(app.settings, 'TOKEN=settings\n', { mode: 0o600 });
  const unit = join(t.home, '.config', 'systemd', 'user', unitName(REPO));
  const state = join(t.home, '.fake-systemd');
  onTestFinished(() => {
    // Stop whatever the fake started.
    for (const f of existsSync(state) ? readdirSync(state) : [])
      if (f.endsWith('.pid'))
        try {
          process.kill(Number(readFileSync(join(state, f), 'utf8')));
        } catch {
          // Already gone.
        }
  });
  // By default CI on main's head is green and the Owner answers yes (slice 23c-1b); the health
  // check waits 3 s, not 30 (slice 23c-2); the start check 10 s for an answer, not 30, then 2 s
  // steady, not 10, still read three times. tests/contract/service.test.ts keeps both real.
  const deploy = (
    env: NodeJS.ProcessEnv = {},
    answers: CliOver['answers'] = ['y'],
    ci = true,
    over: CliOver = {},
  ) => {
    if (ci) pushRunAt(t.mainOnOrigin());
    return t.cli(['deploy'], {
      ...{ healthMs: 3000, startMs: 10_000, steadyMs: 2000 },
      ...{ ...over, env: { ...systemd, ...env }, answers },
    });
  };
  const all = () =>
    existsSync(join(state, 'calls'))
      ? readFileSync(join(state, 'calls'), 'utf8').trim().split('\n')
      : [];
  // Without the polls that check the unit stays running after the answer.
  const calls = () => all().filter((c) => !c.includes('--property=MainPID'));
  const polls = () => all().length - calls().length;
  // Every unit file, by name: the app's and the backup's, never a fourth.
  const units = () => {
    const dir = join(unit, '..');
    return existsSync(dir)
      ? Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]))
      : {};
  };
  return { t, main, port, app, unit, state, deploy, calls, polls, units };
}
const releaseIn = (unit: string) => unitRelease(readFileSync(unit, 'utf8'), REPO);
const [APP, BACKUP, TIMER] = [
  unitName(REPO),
  unitName(REPO, 'backup'),
  unitName(REPO, 'backup', 'timer'),
];
const SWITCH = [
  '--user show --property=Version',
  '--user daemon-reload',
  `--user enable ${APP} ${TIMER}`,
  `--user restart ${APP}`,
  `--user restart ${TIMER}`,
  `--user show --property=Result,ExecMainExitTimestamp ${BACKUP}`,
];

describe(
  'factory deploy: the verified export, the sandboxed build and the switch-over (T069, slices 23a, 23b-2a, 23b-2b)',
  { timeout: 240_000 },
  () => {
    it("exports main's verified commit without .git, builds it, and switches the app's unit to it", async () => {
      const d = deployable(product('node build.mjs'));
      d.t.repo.commit({ 'src/local.ts': 'local\n' }, 'not pushed', { signWith: owner });

      const r = await d.deploy();

      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      const [release, ...more] = releasesOf(d.t.home);
      expect(more).toEqual([]);
      expect(release).toMatch(new RegExp(`/${d.main}-\\d{8}T\\d{6}Z$`));
      expect(readFileSync(join(release ?? '', 'dist', 'out.txt'), 'utf8')).toBe('built');
      expect(existsSync(join(release ?? '', '.git'))).toBe(false);
      expect(existsSync(join(release ?? '', 'src', 'local.ts'))).toBe(false);
      expect(join(d.app.releases, releaseIn(d.unit) ?? '')).toBe(release);
      expect(readFileSync(d.unit, 'utf8')).toContain(`--port ${String(d.port)}\n`);
      expect(d.calls()).toEqual(SWITCH);
      // At the start of the steady window and after each of its 2 s, then by the health check.
      expect(d.polls()).toBeGreaterThanOrEqual(4);
      expect(r.stdout).toContain(`answered on 127.0.0.1:${String(d.port)}`);
      expect(unitRelease(d.units()[BACKUP] ?? '', REPO, 'backup')).toBe(releaseIn(d.unit));
      expect(r.stdout).toContain('Backup: no backup has run yet');
    });

    it('a second deploy rewrites the three units, never adds a fourth, removes old releases and prints a failed backup', async () => {
      const d = deployable(product('node build.mjs'));
      const old = [1, 2, 3].map((day) =>
        join(d.app.releases, `${'0'.repeat(40)}-2020010${String(day)}T000000Z`),
      );
      for (const folder of old) mkdirSync(folder, { recursive: true });
      expect((await d.deploy()).code).toBe(0);
      const first = releaseIn(d.unit) ?? '';
      onMain(d.t.repo, { 'next.txt': 'next\n' }, 'next');
      writeFileSync(
        join(d.state, 'backup-result'),
        'Result=exit-code\nExecMainExitTimestamp=Wed 2026-10-14 03:00:05 UTC',
      );

      const r = await d.deploy();

      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      const second = releaseIn(d.unit) ?? '';
      expect(Object.keys(d.units()).sort()).toEqual([APP, BACKUP, TIMER].sort());
      expect(unitRelease(d.units()[BACKUP] ?? '', REPO, 'backup')).toBe(second);
      expect(releasesOf(d.t.home).sort()).toEqual(
        [join(d.app.releases, first), join(d.app.releases, second), old[2]].sort(),
      );
      expect(r.stdout).toContain(`Removed old releases: ${basename(old[1] ?? '')}`);
      expect(r.stdout).toContain(
        'Backup: the last backup FAILED (exit-code) at Wed 2026-10-14 03:00:05 UTC',
      );
    }, 300_000);

    it.each([
      ['the previous unit goes back', true],
      ['a first unit is removed', false],
    ])('a restart that fails refuses, and %s', async (_, earlier) => {
      const d = deployable(product('node build.mjs'));
      if (earlier) {
        expect((await d.deploy()).code).toBe(0);
        onMain(d.t.repo, { 'next.txt': 'next\n' }, 'next');
      }
      const before = d.units();
      mkdirSync(d.state, { recursive: true });
      writeFileSync(join(d.state, 'fail-restart'), '');

      const r = await d.deploy();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(
        earlier
          ? /restart factory-app-\S+ failed: Job for .*; tried to switch the service back to [0-9a-f]{40}-\S+ and put the backup's units back as they were, but systemctl --user restart .* failed/
          : /restart factory-app-\S+ failed: Job for .*; stopped and disabled the service, which had no earlier unit, and removed its unit, and removed the backup's units; nothing was deployed/,
      );
      expect(d.units()).toEqual(before);
    });

    it('a previous unit whose release cannot be read is still put back, word for word', async () => {
      const d = deployable(product('node build.mjs', false));
      const older = '[Service]\nExecStart=/usr/bin/node /old/factory/main.js serve owner/project\n';
      mkdirSync(join(d.unit, '..'), { recursive: true });
      writeFileSync(d.unit, older);

      const r = await d.deploy();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(
        /did not answer HTTP .*; switched the service back to its previous unit, and removed the backup's units; nothing was deployed/,
      );
      expect(d.units()).toEqual({ [APP]: older });
      expect(d.calls().slice(-2)).toEqual([
        '--user daemon-reload',
        `--user restart ${unitName(REPO)}`,
      ]);
    }, 300_000);

    it('on a first deploy, refuses when something already listens on the port, before exporting anything', async () => {
      const d = deployable(product('node build.mjs'));
      const stranger = createServer((_, res) => res.end('not the app'));
      await new Promise<void>((ok) => stranger.listen(d.port, '127.0.0.1', ok));
      onTestFinished(() => {
        stranger.close();
      });

      const r = await d.deploy();

      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        `something already listens on 127.0.0.1:${String(d.port)}, the app's port (app_port)`,
      );
      expect(existsSync(d.unit)).toBe(false);
      expect(releasesOf(d.t.home)).toEqual([]);
      expect(d.calls()).toEqual(['--user show --property=Version']);
    });

    it('a release that never answers HTTP is switched back to the previous one, and the deploy refuses', async () => {
      const d = deployable(product('node build.mjs'));
      expect((await d.deploy()).code).toBe(0);
      const first = releaseIn(d.unit);
      const before = d.units();
      onMain(d.t.repo, product('node build.mjs', false), 'stops serving', () => {
        rmSync(join(d.t.repo.path, 'serves'));
      });

      const r = await d.deploy();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(
        new RegExp(
          `did not answer HTTP on 127.0.0.1:${String(d.port)} within 10 s; switched the service back to ${first ?? ''}, and put the backup's units back as they were`,
        ),
      );
      // The app's unit and the backup's, both back as they were; the log has the first deploy only.
      expect(d.units()).toEqual(before);
      expect(deployLines(d.t.home)).toHaveLength(1);
      expect(d.calls().slice(-2)).toEqual([`--user restart ${APP}`, `--user restart ${TIMER}`]);
    }, 300_000);

    it('on a first deploy, an app that never answers is stopped, disabled and its unit removed', async () => {
      const d = deployable(product('node build.mjs', false));

      const r = await d.deploy();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/did not answer HTTP .*; stopped and disabled the service/);
      expect(d.units()).toEqual({});
      expect(d.calls().slice(-6)).toEqual([
        ...[`--user stop ${TIMER}`, `--user disable ${TIMER}`, `--user stop ${BACKUP}`],
        ...[`--user stop ${APP}`, `--user disable ${APP}`, '--user daemon-reload'],
      ]);
    }, 300_000);

    it('refuses when main has a first-parent commit not signed by the Owner, before exporting anything (AC-073)', async () => {
      const d = deployable(product('node build.mjs'));
      d.t.repo.checkout('main');
      d.t.repo.commit({ 'src/b.ts': 'b\n' }, 'pushed past the Owner');
      d.t.repo.push('main');

      const r = await d.deploy();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/not signed by the Owner/);
      expect(releasesOf(d.t.home)).toEqual([]);
    });

    it('refuses without a working bubblewrap, before exporting anything, and never builds unsandboxed', async () => {
      const d = deployable(product('node build.mjs'));

      const r = await d.deploy(failingBwrap());

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/only inside bubblewrap.*No permissions to create new namespace/);
      expect(releasesOf(d.t.home)).toEqual([]);
    });

    it('refuses without a settings file, or with a link in its place, before exporting anything', async () => {
      const d = deployable(product('node build.mjs'));
      rmSync(d.app.settings);

      const missing = await d.deploy();
      symlinkSync(ownerKeyPath(d.t.home), d.app.settings);
      const linked = await d.deploy();

      expect(missing.stderr).toContain(`install -D -m 600 /dev/null ${d.app.settings}`);
      expect(linked.stderr).toMatch(/settings\.env is not a regular file/);
      expect([missing.code, linked.code]).toEqual([1, 1]);
      expect(releasesOf(d.t.home)).toEqual([]);
    });

    it('refuses without systemctl --user, before exporting anything', async () => {
      const d = deployable(product('node build.mjs'));

      mkdirSync(join(d.t.home, '.fake-systemd'), { recursive: true });
      writeFileSync(join(d.t.home, '.fake-systemd', 'down'), '');

      const r = await d.deploy();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/systemctl --user.*No medium found/s);
      expect(releasesOf(d.t.home)).toEqual([]);
    });

    it('refuses while another deploy holds the lock, or one that died left it', async () => {
      const d = deployable(product('node build.mjs'));
      const lock = join(d.t.home, '.factory', 'deploy.lock');
      mkdirSync(join(lock, '..'), { recursive: true });
      writeFileSync(lock, String(process.pid));

      const running = await d.deploy();
      writeFileSync(lock, '999999999');
      const stale = await d.deploy();

      expect(running.stderr).toContain(
        `another factory deploy is running (pid ${String(process.pid)})`,
      );
      expect(stale.stderr).toContain(`no longer running (pid 999999999) left ${lock}`);
      expect(releasesOf(d.t.home)).toEqual([]);
      expect(d.calls()).toEqual([]);
    });

    it("a build that reads the Owner's key file under HOME fails, and the unit is untouched", async () => {
      const d = deployable(product('node build.mjs'));
      expect((await d.deploy()).code).toBe(0);
      const first = releaseIn(d.unit);
      const key = ownerKeyPath(d.t.home);
      const steal = `node -e "require('fs').copyFileSync(${JSON.stringify(key).replaceAll('"', "'")}, 'stolen')"`;
      onMain(d.t.repo, product(steal), 'steals');

      const r = await d.deploy();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(
        /the build of [0-9a-f]{40} failed at npm run build; nothing was deployed/,
      );
      expect(r.stderr).toContain('ENOENT');
      for (const release of releasesOf(d.t.home))
        expect(existsSync(join(release, 'stolen'))).toBe(false);
      expect(releaseIn(d.unit)).toBe(first);
      // Only the first deploy's restarts, the app's and the timer's.
      expect(d.calls().filter((c) => c.includes('restart'))).toHaveLength(2);
    });

    it('a failed build refuses, naming the step, with the end of its output', async () => {
      const d = deployable(product(`node -e "console.error('tsc: 3 errors'); process.exit(2)"`));

      const r = await d.deploy();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/failed at npm run build; nothing was deployed/);
      expect(r.stderr).toContain('tsc: 3 errors');
      expect(existsSync(d.unit)).toBe(false);
    });
  },
);

const deployLog = (home: string) => deploysLogPath(home, REPO);
const deployLines = (home: string) =>
  existsSync(deployLog(home))
    ? readFileSync(deployLog(home), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { main: string; release: string; healthy?: string })
    : [];
const NOTE_PATH = '.factory/releases/v1.md';
const NOTE = [
  ...['# Release v1', '', '- #7 Add login', '', '## Rollback', ''],
  ...['1. Run factory deploy at the previous commit.', '', '## Notes', '', 'Nothing else.', ''],
].join('\n');
/** `files` committed on claude/factory-log as origin has it, or cut from main, and pushed. */
function onLog(repo: TestRepo, files: Files): string {
  repo.git(['fetch', '-q', 'origin']);
  const remote = repo.git(['branch', '-r', '--list', `origin/${LOG_BRANCH}`]) !== '';
  repo.git(['checkout', '-q', '-B', LOG_BRANCH, remote ? `origin/${LOG_BRANCH}` : 'main']);
  const sha = repo.commit(files, 'release note');
  repo.push(LOG_BRANCH);
  repo.checkout('main');
  return sha;
}
/**
 * Item #7 merged into main as `factory merge` writes it: signed, its trailer and its branch; its
 * release note, unless null, on claude/factory-log.
 */
function mergeItem(repo: TestRepo, note: string | null = NOTE): string {
  repo.checkout('main');
  repo.git([
    ...['-c', 'gpg.format=ssh', '-c', `user.signingkey=${owner.privateKey}`],
    ...['merge', '-q', '--no-ff', '-S', '-m', `Merge #${String(ITEM)} from ${ITEM_BRANCH}`],
    ...['-m', `Factory-Merge: #${String(ITEM)}`, ITEM_BRANCH],
  ]);
  repo.push('main');
  const merge = repo.revParse('HEAD');
  if (note !== null) onLog(repo, { [NOTE_PATH]: note });
  return merge;
}
/** The item's records as the fake GitHub holds them. */
const itemComments = () =>
  readState().repos[REPO]?.issues.find((i) => i.number === ITEM)?.comments ?? [];
const nonceOf = (body: string) => /\bnonce: ([0-9a-f]{32})\b/.exec(body)?.[1] ?? '';

describe(
  'factory deploy: the items since the last deploy, re-verified (T069, FR-016f, slice 23c-1a)',
  { timeout: 300_000 },
  () => {
    it('re-verifies each item merged since the last deploy; main deployed last refuses; a config set alone deploys', async () => {
      const d = deployable(product('node build.mjs'));
      const merge = mergeItem(d.t.repo);

      const first = await d.deploy();
      const again = await d.deploy();
      const config = runGit(d.t.repo.path, ['show', 'main:.factory/config']);
      const port = nextPort++;
      const set = onMain(
        d.t.repo,
        { '.factory/config': config.replace(/^app_port: \d+$/m, `app_port: ${String(port)}`) },
        'config: app_port',
      );
      const third = await d.deploy();

      expect(first.stderr).toBe('');
      expect(first.code).toBe(0);
      expect(first.stdout).toMatch(
        /Since the baseline: \d+ commit\(s\); re-verified the approvals of #7\n/,
      );
      expect(d.t.asked).toEqual([
        `Deploy ${merge} to this laptop? [y/N] `,
        `Deploy ${set} to this laptop? [y/N] `,
      ]);
      expect(again.code).toBe(1);
      expect(again.stderr).toContain(`main is already deployed at ${merge}: there is nothing new`);
      expect(third.stderr).toBe('');
      expect(third.code).toBe(0);
      expect(third.stdout).toContain(
        `Since the last deploy (${merge.slice(0, 12)}): 1 commit(s); no items merged\n`,
      );
      expect(third.stdout).toContain(`answered on 127.0.0.1:${String(port)}`);
      expect(deployLines(d.t.home).map((l) => l.main)).toEqual([merge, set]);
      expect(releasesOf(d.t.home)).toHaveLength(2);
    });

    it('reads each merge with its own git settings: log.showSignature in the Owner’s config changes nothing', async () => {
      const d = deployable(product('node build.mjs'));
      mergeItem(d.t.repo);
      const global = join(d.t.home, 'gitconfig');
      writeFileSync(global, '[log]\n\tshowSignature = true\n');
      d.t.repo.git(['config', 'log.showSignature', 'true']);

      const r = await d.deploy({ GIT_CONFIG_GLOBAL: global });

      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('re-verified the approvals of #7\n');
    });

    it('a record of a shipped item that no longer verifies refuses before anything is exported', async () => {
      const d = deployable(product('node build.mjs'));
      const merge = mergeItem(d.t.repo);
      const state = readState();
      const approved = state.repos[REPO]?.issues.find((i) => i.number === ITEM)?.comments[0];
      if (approved === undefined) throw new Error('no approved record');
      approved.body = approved.body.replace('tier: 2', 'tier: 1');
      writeFileSync(process.env.FAKE_GH_STATE ?? '', JSON.stringify(state));

      const r = await d.deploy();

      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        `the approvals of #7 (merged in ${merge.slice(0, 12)}) do not verify: #7 has no verified owner:approved`,
      );
      expect(r.stderr).toMatch(/nothing was deployed/);
      expect(releasesOf(d.t.home)).toEqual([]);
      expect(d.units()).toEqual({});
      expect(deployLines(d.t.home)).toEqual([]);
    });

    it('re-verifies with the key lists at main’s head: a key revoked since the merge refuses', async () => {
      const d = deployable(product('node build.mjs'), {
        release: [other, owner],
        chain: ({ specBlob }) => [
          posted(900, itemRecord('approved'), '2026-10-01T08:00:00Z', other),
          posted(
            901,
            itemRecord('spec-approved', { spec_sha: specBlob }),
            '2026-10-01T08:30:00Z',
            other,
          ),
        ],
      });
      const merge = mergeItem(d.t.repo);
      d.t.factory.commit({ revoked_keys: readFileSync(other.publicKeyPath, 'utf8') }, 'revoke');
      signedReleaseTag(d.t.factory, owner, 'v1.0.1');
      const config = runGit(d.t.repo.path, ['show', 'main:.factory/config']);
      const pin = `v1.0.1@${d.t.factory.revParse('HEAD')}`;
      onMain(
        d.t.repo,
        { '.factory/config': config.replace(/^factory_release: .*$/m, `factory_release: ${pin}`) },
        'pin v1.0.1',
      );

      const r = await d.deploy();

      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        `the approvals of #7 (merged in ${merge.slice(0, 12)}) do not verify: #7 has no verified owner:approved`,
      );
      expect(releasesOf(d.t.home)).toEqual([]);
    });

    it.each([
      ['the same item and comment', `${REPO}#7/900`, 0],
      ['another comment', `${REPO}#9/950`, 1],
    ])('a nonce the ledger holds for %s', async (_, ref, code) => {
      const d = deployable(product('node build.mjs'));
      mergeItem(d.t.repo);
      const nonce = nonceOf(itemComments()[0]?.body ?? '');
      mkdirSync(join(nonceLedgerPath(d.t.home), '..'), { recursive: true });
      writeFileSync(nonceLedgerPath(d.t.home), `${nonce} ${ref}\n`);

      const r = await d.deploy();

      expect(r.code).toBe(code);
      if (code === 1) {
        expect(r.stderr).toContain(
          `the approved record in comment 900: nonce ${nonce} was first seen on another comment`,
        );
        expect(releasesOf(d.t.home)).toEqual([]);
      } else expect(r.stderr).toBe('');
    });

    it.each([
      [
        'a link',
        (log: string) => {
          symlinkSync('/dev/null', log);
        },
        /is not a regular file/,
      ],
      [
        'a malformed line',
        (log: string) => {
          writeFileSync(log, 'not json\n');
        },
        /line 1 is not a deploy this factory wrote/,
      ],
      [
        'a commit that is not on main',
        (log: string) => {
          writeFileSync(log, `${JSON.stringify({ at: AT, main: 'a'.repeat(40), release: 'r' })}\n`);
        },
        /the last deploy, a{40}, is not on main's verified first-parent history/,
      ],
    ])('deploys.log holding %s refuses before anything is exported', async (_, plant, said) => {
      const d = deployable(product('node build.mjs'));
      mkdirSync(join(deployLog(d.t.home), '..'), { recursive: true });
      plant(deployLog(d.t.home));

      const r = await d.deploy();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(said);
      expect(releasesOf(d.t.home)).toEqual([]);
    });

    it('warns during a pause and refuses unless the Owner confirms (AC-078)', async () => {
      const d = deployable(product('node build.mjs'), { inbox: [labeledAt('pause:line', AT)] });

      const r = await d.deploy({}, ['n']);

      expect(r.code).toBe(1);
      expect(r.stderr).toContain('warning: the line is paused (pause:line)');
      expect(r.stderr).toContain('the Owner did not confirm; nothing was deployed');
      expect(d.t.asked).toEqual(['Deploy anyway while paused? [y/N] ']);
      expect(releasesOf(d.t.home)).toEqual([]);
    });
  },
);

/** The comments on the Owner inbox as the fake GitHub holds them. */
const inboxComments = () =>
  readState().repos[REPO]?.issues.find((i) => i.number === 1)?.comments ?? [];
const NO_ROLLBACK = `no release note on main or origin/claude/factory-log gives rollback steps for #7`;

describe(
  "factory deploy: CI on main's head, the rollback steps, the summary and the signed deployed record (T069, AC-095, slice 23c-1b)",
  { timeout: 300_000 },
  () => {
    it('shows the summary, asks, then signs and posts the deployed record on the inbox, and logs its comment id', async () => {
      const d = deployable(product('node build.mjs'));
      const merge = mergeItem(d.t.repo);

      const r = await d.deploy();

      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(d.t.asked).toEqual([`Deploy ${merge} to this laptop? [y/N] `]);
      for (const shown of [
        `Approval summary for #1 (deployed) at ${merge}:`,
        `  #7 merged in ${merge.slice(0, 12)} from ${ITEM_BRANCH}\n  quoted from issue #7 (its title, issue text):\n  > Add login\n`,
        "  CI on main's head (GitHub Actions workflow runs):\n  build-test (.github/workflows/ci.yml): success\n",
        '  #7: tier 2\n',
      ])
        expect(r.stdout).toContain(shown);
      expect(r.stdout).toMatch(
        /Rollback steps for #7:\n {2}quoted from \.factory\/releases\/v1\.md on origin\/claude\/factory-log at [0-9a-f]{12}, not merged:\n {2}> 1\. Run factory deploy at the previous commit\.\n\n/,
      );
      expect(r.stdout.indexOf('Approval summary')).toBeLessThan(r.stdout.indexOf('Exported'));
      // A healthy deploy's second record follows (slice 23d).
      const [comment, healthy, ...more] = inboxComments();
      expect(more).toEqual([]);
      expect(recordOf(healthy?.body ?? '').gate).toBe('deploy-healthy');
      const signed = extractFromComment(comment?.body ?? '');
      expect(verifySignature(signed, writeKeyFiles([owner]))).toBe(true);
      expect(
        matchFields(parse(signed.text), { repo: REPO, issue: 1, gate: 'deployed', head: merge }),
      ).toBeUndefined();
      const id = String(comment?.id);
      expect(readFileSync(nonceLedgerPath(d.t.home), 'utf8')).toContain(
        `${nonceOf(comment?.body ?? '')} ${REPO}#1/${id}`,
      );
      expect(deployLines(d.t.home)).toMatchObject([{ main: merge, record: id }]);
    });

    it('signs and exports nothing when the Owner declines', async () => {
      const d = deployable(product('node build.mjs'));

      const r = await d.deploy({}, ['n']);

      expect(r.code).toBe(1);
      expect(r.stderr).toContain('the Owner did not confirm the deploy; nothing was deployed');
      expect(d.t.asked).toEqual([`Deploy ${d.main} to this laptop? [y/N] `]);
      expect(inboxComments()).toEqual([]);
      expect(releasesOf(d.t.home)).toEqual([]);
    });

    it.each([
      [
        'still running',
        (sha: string) => {
          pushRunAt(sha, null);
        },
        /CI on main's head is still running; run factory deploy again when it finishes/,
      ],
      [
        'failed',
        (sha: string) => {
          pushRunAt(sha, 'failure');
        },
        /CI on main's head is not green at [0-9a-f]{40}[^]*build-test \(\.github\/workflows\/ci\.yml\): failure/,
      ],
      [
        'with no run at all',
        (sha: string) => {
          pushRunAt(sha, 'success', { none: true });
        },
        /no CI run on main's head yet: it may still be starting, or the project's \.github\/workflows\/ci\.yml predates CI on main \(install the pinned release's workflows\/ci\.yml\); run factory deploy again shortly/,
      ],
      [
        'only in a push run of the same commit on a claude/** branch',
        (sha: string) => {
          pushRunAt(sha, 'success', { branch: 'claude/7-add-login' });
        },
        /no CI run on main's head yet: it may still be starting, or the project's \.github\/workflows\/ci\.yml predates CI on main \(install the pinned release's workflows\/ci\.yml\); run factory deploy again shortly/,
      ],
      [
        'only in a workflow_dispatch run at the same commit',
        (sha: string) => {
          pushRunAt(sha, 'success', { event: 'workflow_dispatch' });
        },
        /no CI run on main's head yet: it may still be starting, or the project's \.github\/workflows\/ci\.yml predates CI on main \(install the pinned release's workflows\/ci\.yml\); run factory deploy again shortly/,
      ],
      [
        'in a run without build-test',
        (sha: string) => {
          pushRunAt(sha, 'success', { job: 'lint' });
        },
        /build-test \(\.github\/workflows\/ci\.yml\): missing\n {2}a required job is not in the run on main[^]*may predate CI on main/,
      ],
    ])('CI on main %s refuses before anything is signed', async (_, ci, said) => {
      const d = deployable(product('node build.mjs'));
      ci(d.main);

      const r = await d.deploy({}, ['y'], false);

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(said);
      expect(r.stderr).toContain('nothing was deployed');
      expect(d.t.asked).toEqual([]);
      expect(inboxComments()).toEqual([]);
      expect(releasesOf(d.t.home)).toEqual([]);
    });

    it.each([
      ['no release note', (repo: TestRepo) => mergeItem(repo, null), NO_ROLLBACK],
      [
        'a note naming only #70',
        (repo: TestRepo) => mergeItem(repo, NOTE.replace('#7 ', '#70 ')),
        NO_ROLLBACK,
      ],
      [
        'a note without a Rollback section',
        (repo: TestRepo) => mergeItem(repo, NOTE.replace('## Rollback', '## Undo')),
        /\.factory\/releases\/v1\.md on origin\/claude\/factory-log at [0-9a-f]{12}, not merged, has no ## Rollback section/,
      ],
      [
        'an empty Rollback section',
        (repo: TestRepo) =>
          mergeItem(repo, NOTE.replace('1. Run factory deploy at the previous commit.', '  ')),
        /\.factory\/releases\/v1\.md on origin\/claude\/factory-log at [0-9a-f]{12}, not merged, has an empty ## Rollback section/,
      ],
      [
        'a note that is a link',
        (repo: TestRepo) => {
          mergeItem(repo, null);
          onLog(repo, { '.factory/releases/notes.txt': NOTE });
          repo.checkout(LOG_BRANCH);
          symlinkSync('notes.txt', join(repo.path, NOTE_PATH));
          repo.git(['add', NOTE_PATH]);
          repo.git(['commit', '-q', '-m', 'a link']);
          repo.push(LOG_BRANCH);
          repo.checkout('main');
        },
        NO_ROLLBACK,
      ],
      [
        'a note over 64 KiB',
        (repo: TestRepo) => mergeItem(repo, `${NOTE}${'x'.repeat(65 * 1024)}\n`),
        /\.factory\/releases\/v1\.md on origin\/claude\/factory-log at [0-9a-f]{12}, not merged, is over 64 KiB/,
      ],
    ])('a shipped item with %s refuses before anything is signed', async (_, plant, said) => {
      const d = deployable(product('node build.mjs'));
      plant(d.t.repo);

      const r = await d.deploy();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(said);
      expect(r.stderr).toContain('nothing was deployed');
      expect(inboxComments()).toEqual([]);
      expect(releasesOf(d.t.home)).toEqual([]);
    });

    it("main's note wins: with differing notes on main and on the log branch, only main's steps are shown", async () => {
      const d = deployable(product('node build.mjs'));
      mergeItem(d.t.repo);
      const ours = NOTE.replace(
        'Run factory deploy at the previous commit.',
        'Restore the backup.',
      );
      const main = onMain(d.t.repo, { [NOTE_PATH]: ours }, 'release note');

      const r = await d.deploy();

      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(
        `Rollback steps for #7:\n  quoted from .factory/releases/v1.md on main at ${main.slice(0, 12)}:\n  > 1. Restore the backup.\n\n`,
      );
      expect(r.stdout).not.toContain('Run factory deploy at the previous commit.');
      expect(r.stdout).not.toContain('origin/claude/factory-log at');
    });

    it("refuses before anything else when this laptop's key is not the newest listed one", async () => {
      const d = deployable(product('node build.mjs'), { release: [owner, other] });

      const r = await d.deploy();

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/finish the rotation: .* \(factory keygen --rotate --finish\)/);
      expect(r.stderr).toContain('nothing was deployed');
      expect(inboxComments()).toEqual([]);
      expect(releasesOf(d.t.home)).toEqual([]);
    });
  },
);

const HEALTH = '.factory/ops/health/';
/** The health summaries on origin's claude/factory-log, with their text. */
const healthFiles = (repo: TestRepo) =>
  (runGit(repo.origin, ['branch', '--list', LOG_BRANCH]) === ''
    ? ''
    : runGit(repo.origin, ['ls-tree', '--name-only', LOG_BRANCH, HEALTH])
  )
    .split('\n')
    .filter((path) => path !== '')
    .map((path) => ({ path, text: runGit(repo.origin, ['show', `${LOG_BRANCH}:${path}`]) }));
const parentsOf = (repo: TestRepo, sha: string) =>
  runGit(repo.origin, ['rev-list', '--parents', '-n', '1', sha]).split(' ').slice(1);
const UNHEALTHY = 'the database is down';

describe(
  'factory deploy: the health check, the health summary and the failure comment (T069, T053, AC-015, AC-060, slice 23c-2)',
  { timeout: 300_000 },
  () => {
    it('a healthy deploy writes its health summary on claude/factory-log, fast-forward, and a log merge carrying it passes both log rules', async () => {
      const d = deployable(product('node build.mjs'));
      const merge = mergeItem(d.t.repo);
      const before = branchOnOrigin(d.t.repo, LOG_BRANCH);

      const r = await d.deploy();

      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Health: GET /health answered 200 {"status":"ok"}\n');
      const after = branchOnOrigin(d.t.repo, LOG_BRANCH);
      expect(parentsOf(d.t.repo, after)).toEqual([before]);
      expect(runGit(d.t.repo.origin, ['log', '-1', '--format=%an <%ae> %cn', after])).toBe(
        'factory deploy <deploy@invalid> factory deploy',
      );
      const [file, ...more] = healthFiles(d.t.repo);
      expect(more).toEqual([]);
      expect(file?.path).toMatch(/^\.factory\/ops\/health\/\d{8}T\d{6}Z\.md$/);
      const [record] = inboxComments();
      for (const line of [
        `- Version: main ${merge}, release ${releaseIn(d.unit) ?? ''}`,
        '- Status: healthy',
        `- Deployed record: comment ${String(record?.id)} on #1, nonce ${nonceOf(record?.body ?? '')}`,
        `  - Start check: answered on 127.0.0.1:${String(d.port)}, one main process for 2 s`,
        '  - Health: GET /health answered 200 {"status":"ok"}',
        '  - Backup: no backup has run yet',
      ])
        expect(`${file?.text ?? ''}\n`).toContain(`${line}\n`);

      d.t.repo.git(['fetch', '-q', 'origin']);
      expect(mergeRules(input(d.t.repo, merge, LOG_BRANCH, after))).toEqual({
        rule: 'factory-log',
        problems: [],
      });
      expect(
        checkAppendOnly(d.t.repo.path, before, after, { logBranch: true, push: true }),
      ).toEqual([]);
      for (const range of [
        [before, after, '--push'],
        [merge, after],
      ]) {
        const ci = await d.t.cli(['ci', 'append-only', ...range, '--branch', LOG_BRANCH]);
        expect(ci.stderr).toBe('');
        expect(ci.code).toBe(0);
      }
    });

    it('with no claude/factory-log on origin, the summary starts it from main', async () => {
      const d = deployable(product('node build.mjs'));

      const r = await d.deploy();

      expect(r.code).toBe(0);
      expect(parentsOf(d.t.repo, branchOnOrigin(d.t.repo, LOG_BRANCH))).toEqual([d.main]);
      expect(healthFiles(d.t.repo)).toHaveLength(1);
    });

    it("an agent's push to claude/factory-log during the deploy stays: the summary goes on top of it", async () => {
      const d = deployable(product('node build.mjs'));
      mergeItem(d.t.repo);
      const agent = tempDir('agent-');
      mkdirSync(d.state, { recursive: true });
      writeFileSync(
        join(d.state, `on-restart.${APP}`),
        [
          `git clone -q -b ${LOG_BRANCH} ${d.t.repo.origin} ${agent}`,
          `cd ${agent} && mkdir -p .factory/ops && echo seen > .factory/ops/agent.md`,
          'git add . && git -c user.name=agent -c user.email=agent@invalid commit -qm agent',
          `git push -q origin ${LOG_BRANCH}`,
        ].join(' && '),
      );

      const r = await d.deploy();

      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      const after = branchOnOrigin(d.t.repo, LOG_BRANCH);
      const [parent = ''] = parentsOf(d.t.repo, after);
      expect(runGit(d.t.repo.origin, ['log', '-1', '--format=%an', parent])).toBe('agent');
      expect(runGit(d.t.repo.origin, ['show', `${after}:.factory/ops/agent.md`])).toBe('seen');
      expect(healthFiles(d.t.repo)).toHaveLength(1);
    });

    it('a summary that cannot be pushed is a warning, printed in full; the deploy still counts', async () => {
      const d = deployable(product('node build.mjs'));
      d.t.repo.git(['config', 'remote.origin.pushurl', join(tempDir(), 'nowhere.git')]);

      const r = await d.deploy();

      expect(r.code).toBe(0);
      expect(r.stderr).toMatch(
        /^warning: the health summary could not be pushed to claude\/factory-log after 3 tries: /m,
      );
      expect(r.stdout).toContain('- Status: healthy\n');
      expect(deployLines(d.t.home)).toHaveLength(1);
    });

    it('a summary never replaces a file: one already at its path fails each try, then the warning with the summary in full', async () => {
      const d = deployable(product('node build.mjs'));
      const now = new Date();
      const path = `${HEALTH}${stamp(now)}.md`;
      const before = onLog(d.t.repo, { [path]: 'written first\n' });

      const r = await d.deploy({}, ['y'], true, { now: () => now });

      expect(r.code).toBe(0);
      expect(r.stderr).toBe(
        `warning: the health summary could not be pushed to claude/factory-log after 3 tries: ${path} already exists on claude/factory-log at ${before.slice(0, 12)}\n`,
      );
      expect(r.stdout).toContain('- Status: healthy\n');
      expect(branchOnOrigin(d.t.repo, LOG_BRANCH)).toBe(before);
      expect(runGit(d.t.repo.origin, ['show', `${LOG_BRANCH}:${path}`])).toBe('written first');
      expect(deployLines(d.t.home)).toHaveLength(1);
    });

    it.each([
      ['switches back on yes', 'y'],
      ['keeps the new release running on no', 'n'],
      ['says so when the switch back fails partly', 'fails'],
    ])('a failed health check shows the rollback steps, asks, and %s', async (_, choice) => {
      const d = deployable(product('node build.mjs'));
      expect((await d.deploy()).code).toBe(0);
      const first = releaseIn(d.unit) ?? '';
      mergeItem(d.t.repo);
      onMain(d.t.repo, { serves: UNHEALTHY }, 'break the health check');
      // The units are written back, then every restart fails.
      const answer = () => {
        if (choice === 'fails') writeFileSync(join(d.state, 'fail-restart'), '');
        return choice === 'n' ? 'n' : 'y';
      };

      const r = await d.deploy({}, ['y', answer]);

      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`the health check failed: GET /health answered 503 ${UNHEALTHY}`);
      expect(d.t.asked.at(-1)).toBe(`Switch back to ${first}? [y/N] `);
      const shown = r.stdout.lastIndexOf('> 1. Run factory deploy at the previous commit.');
      expect(shown).toBeGreaterThan(r.stdout.indexOf(`Health: GET /health answered 503`));
      const second = releasesOf(d.t.home)
        .map((f) => basename(f))
        .find((f) => f !== first);
      expect(releaseIn(d.unit)).toBe(choice === 'n' ? second : first);
      const restart = `systemctl --user restart ${APP} failed: Job for ${APP} failed`;
      expect(r.stderr).toContain(
        {
          y: `switched the service back to ${first}`,
          n: `the new release ${second ?? ''} keeps running`,
          fails: `tried to switch the service back to ${first} and put the backup's units back as they were, but ${restart}`,
        }[choice],
      );
      expect(releasesOf(d.t.home)).toHaveLength(2);
      expect(deployLines(d.t.home)).toHaveLength(1);
      const status = healthFiles(d.t.repo).map((f) => /^- Status: (.*)$/m.exec(f.text)?.[1]);
      expect(status).toHaveLength(2);
      expect(status).toContain('healthy');
      expect(status).toContainEqual(
        {
          y: `unhealthy, switched back to ${first}`,
          n: 'unhealthy, kept running',
          fails: expect.stringMatching(
            `^unhealthy, switch back to ${first} failed: ${restart}.*; systemctl --user restart ${TIMER} failed`,
          ) as unknown,
        }[choice],
      );
    });

    it('an error during the health check counts as unhealthy, with the error as the answer; the Owner still gets the steps, the question and the summary', async () => {
      const d = deployable(product('node build.mjs'));
      expect((await d.deploy()).code).toBe(0);
      const first = releaseIn(d.unit) ?? '';
      mergeItem(d.t.repo);
      // The timer restarts last in the switch, after the start check: from then on `show` fails.
      writeFileSync(join(d.state, `on-restart.${TIMER}`), `touch ${join(d.state, 'fail-show')}`);

      const r = await d.deploy({}, ['y', 'n']);

      const error = `error during the check: systemctl --user show --property=ActiveState --property=MainPID ${APP} failed: Failed to get properties: Connection timed out`;
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(`Health: ${error}\n`);
      expect(r.stdout).toContain('> 1. Run factory deploy at the previous commit.');
      expect(d.t.asked.at(-1)).toBe(`Switch back to ${first}? [y/N] `);
      expect(r.stderr).toContain(`the health check failed: ${error}; the new release`);
      const unhealthy = healthFiles(d.t.repo).find((f) => !f.text.includes('- Status: healthy'));
      expect(unhealthy?.text).toContain('- Status: unhealthy, kept running\n');
      expect(unhealthy?.text).toContain(`  - Health: ${error}\n`);
      expect(deployLines(d.t.home)).toHaveLength(1);
    });

    it('on a first deploy an unhealthy app has nothing to switch back to; at most 4 KiB of its answer is read, shown through visible()', async () => {
      const d = deployable(product('node build.mjs', `\u001b[2J${'x'.repeat(10_000)}`));

      const r = await d.deploy();

      expect(r.code).toBe(1);
      expect(d.t.asked).toEqual([`Deploy ${d.main} to this laptop? [y/N] `]);
      expect(r.stderr).toContain('there is no earlier release to switch back to');
      expect(r.stderr).toContain(`GET /health answered 503 \\u{1b}[2J${'x'.repeat(4092)}`);
      expect(r.stderr).not.toContain('x'.repeat(4093));
      expect(r.stderr).not.toContain('\u001b');
      expect(deployLines(d.t.home)).toEqual([]);
    });

    it.each([
      ['build', () => product(`node -e "process.exit(2)"`), false],
      ['switch', () => product('node build.mjs'), true],
    ])(
      'a deploy that fails at the %s after signing posts an unsigned comment saying so on the inbox',
      async (step, files, failRestart) => {
        const d = deployable(files());
        if (failRestart) {
          mkdirSync(d.state, { recursive: true });
          writeFileSync(join(d.state, 'fail-restart'), '');
        }

        const r = await d.deploy();

        expect(r.code).toBe(1);
        const [record, failed, ...more] = inboxComments();
        expect(record?.body).toContain('gate: deployed');
        expect(failed?.body).toBe(
          `deploy of ${d.main} failed at the ${step}; nothing was deployed`,
        );
        expect(more).toEqual([]);
        expect(healthFiles(d.t.repo)).toEqual([]);
        expect(deployLines(d.t.home)).toEqual([]);
      },
    );

    it('a signing failure posts, exports and builds nothing (AC-015)', async () => {
      const d = deployable(product('node build.mjs'));
      chmodSync(ownerKeyPath(d.t.home), 0o000);

      const r = await d.deploy();

      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/sign/i);
      expect(inboxComments()).toEqual([]);
      expect(releasesOf(d.t.home)).toEqual([]);
      expect(d.units()).toEqual({});
    });
  },
);

/** The signed record a comment posts, as its fields. */
const recordOf = (body: string) => parse(extractFromComment(body).text);
/**
 * `tool` first on PATH: it fails its second call matching `match`, printing `why`, as a wrong
 * passphrase fails `ssh-keygen -Y sign` or a refused post fails `gh issue comment`, and runs the
 * real tool otherwise. The test keys have no passphrase, so nothing else can fail it.
 */
function failsSecond(tool: string, match: string, why: string): NodeJS.ProcessEnv {
  const real = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
  const bin = tempDir();
  const count = join(bin, 'count');
  writeFileSync(
    join(bin, tool),
    [
      '#!/bin/sh',
      `case " $* " in *" ${match} "*)`,
      `  n=$(($(cat '${count}' 2>/dev/null || echo 0) + 1)); echo $n > '${count}'`,
      `  if [ $n = 2 ]; then echo '${why}' >&2; exit 255; fi;;`,
      'esac',
      `exec '${real}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, tool), 0o755);
  return { PATH: `${bin}:${systemd.PATH}` };
}
const EMPTY_SKIPS =
  'An empty passphrase skips the deploy-healthy record: the release keeps running, without cleanup or a deploys.log line\n';

describe(
  'factory deploy: the signed deploy-healthy record (T069, T160, AC-060, slice 23d)',
  { timeout: 300_000 },
  () => {
    it('a healthy deploy shows the Deploy health summary, then signs deploy-healthy naming its deployed record, before the cleanup and deploys.log', async () => {
      const d = deployable(product('node build.mjs'));
      expect((await d.deploy()).code).toBe(0);
      const merge = mergeItem(d.t.repo);

      const r = await d.deploy();

      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      const [, , deployed, healthy, ...more] = inboxComments();
      expect(more).toEqual([]);
      expect(recordOf(deployed?.body ?? '')).toMatchObject({ gate: 'deployed', head: merge });
      expect(recordOf(healthy?.body ?? '')).toMatchObject({
        ...{ repo: REPO, issue: 1, gate: 'deploy-healthy', head: merge },
        deployed: nonceOf(deployed?.body ?? ''),
      });
      const order = [
        'Wrote the health summary',
        `Approval summary for #1 (deploy-healthy) at ${merge}:`,
        `The deployed record it confirms: comment ${String(deployed?.id)} on the inbox, nonce ${nonceOf(deployed?.body ?? '')}`,
        'Health check, run on this laptop: GET /health answered 200 {"status":"ok"}',
        '> 1. Run factory deploy at the previous commit.',
        EMPTY_SKIPS,
        `Signed the deploy-healthy record: comment ${String(healthy?.id)} on #1`,
      ].map((line) => r.stdout.lastIndexOf(line));
      expect(order).not.toContain(-1);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(d.t.asked).toEqual([
        `Deploy ${d.main} to this laptop? [y/N] `,
        `Deploy ${merge} to this laptop? [y/N] `,
      ]);
      expect(deployLines(d.t.home).at(-1)).toMatchObject({
        main: merge,
        record: String(deployed?.id),
        healthy: String(healthy?.id),
      });
    });

    it.each([
      [
        'a wrong passphrase',
        'ssh-keygen',
        '-Y sign',
        'incorrect passphrase supplied to decrypt private key',
      ],
      ['a failed post', 'gh', 'issue comment', 'HTTP 502: Bad Gateway'],
    ])(
      'after %s the release keeps running without cleanup or deploys.log, and the next deploy redeploys the commit and signs both',
      async (_, tool, match, why) => {
        const d = deployable(product('node build.mjs'));

        const r = await d.deploy(failsSecond(tool, match, why));

        expect(r.code).toBe(1);
        const release = releaseIn(d.unit) ?? '';
        expect(r.stdout).toContain(EMPTY_SKIPS);
        expect(r.stderr).toContain(`the deploy-healthy record was not signed: `);
        expect(r.stderr).toContain(why);
        expect(r.stderr).toContain(
          `; ${release} keeps running; run factory deploy again to redeploy ${d.main} and sign it\n`,
        );
        expect(inboxComments().map((c) => recordOf(c.body).gate)).toEqual(['deployed']);
        expect(deployLines(d.t.home)).toEqual([]);
        expect(healthFiles(d.t.repo).map((f) => /^- Status: (.*)$/m.exec(f.text)?.[1])).toEqual([
          'healthy',
        ]);

        const again = await d.deploy();

        expect(again.stderr).toBe('');
        expect(again.code).toBe(0);
        expect(releaseIn(d.unit)).not.toBe(release);
        expect(releasesOf(d.t.home).map((f) => basename(f))).toContain(release);
        const [first, deployed, healthy, ...more] = inboxComments();
        expect(more).toEqual([]);
        for (const c of [first, deployed])
          expect(recordOf(c?.body ?? '')).toMatchObject({ gate: 'deployed', head: d.main });
        expect(recordOf(healthy?.body ?? '')).toMatchObject({
          ...{ gate: 'deploy-healthy', head: d.main },
          deployed: nonceOf(deployed?.body ?? ''),
        });
        expect(deployLines(d.t.home)).toMatchObject([
          { main: d.main, record: String(deployed?.id), healthy: String(healthy?.id) },
        ]);
      },
    );
  },
);
