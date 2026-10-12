// `factory merge` and `factory deploy` (T053). Slice 21 writes the per-branch rule cases
// (AC-081–AC-083, AC-086, FR-016g) against src/merge/rules.ts, with the inputs `factory merge`
// will pass in; the command's own cases come with slices 22a, 22a-2, 22a-3, 22b and 23a.
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReleaseKeys } from '../../src/approvals/keys.js';
import { renderComment } from '../../src/approvals/record.js';
import { ownerKeyPath, sign } from '../../src/approvals/sign.js';
import { runCli } from '../../src/cli/commands.js';
import { serialiseManifest } from '../../src/install/manifest.js';
import {
  mergeRules,
  originRepo,
  releaseSource,
  type MergeRulesInput,
  type PullRequest,
} from '../../src/merge/rules.js';
import type { ApprovalRecord } from '../../src/model/types.js';
import { NO_FORMAL } from '../../src/notify/summary.js';
import { calls, seedState, type FakeLabelEvent } from '../helpers/fake-gh.js';
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
const NOT_YET = 'the merge itself comes with slice 22b; nothing was merged';
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
  /** The item's labels, when not `tier:<tier>` and `owner:approved`. */
  labels?: string[];
  /** The repository the PR's head branch lives in, when it is a fork. */
  headRepository?: string;
}

function mergeSetup(o: MergeSetup = {}) {
  const release = o.release ?? [owner];
  const factory = makeRepo({
    files: {
      allowed_signers: signersOf(release),
      revoked_keys: '',
      'factory/workflows/ci.yml': `env:\n  FACTORY_REPO: ${FACTORY_REPO}\n`,
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
  if (!o.noConfig) mergeBrief(repo, { signWith: owner });
  o.project?.(repo);
  const branchName = o.branch ?? ITEM_BRANCH;
  const head = branch(repo, branchName, {
    '.specify/feature.json': '{ "feature_directory": "specs/7-add-login" }\n',
    'specs/7-add-login/spec.md': ITEM_SPEC,
    'src/login.ts': 'export {};\n',
    ...o.files,
  });
  repo.push(branchName);

  const home = tempDir('factory-home-');
  mkdirSync(join(home, '.factory', 'keys'), { recursive: true });
  writeFileSync(join(home, '.factory', 'allowed_signers'), signersOf(release));
  writeFileSync(join(home, '.factory', 'revoked_keys'), '');
  copyFileSync(owner.privateKey, ownerKeyPath(home));
  chmodSync(ownerKeyPath(home), 0o600);
  copyFileSync(owner.publicKeyPath, `${ownerKeyPath(home)}.pub`);

  const tier = o.tier === undefined ? 2 : o.tier;
  const approved: ApprovalRecord = {
    ...{ repo: REPO, issue: ITEM, gate: 'approved', tier: tier ?? 2, branch: ITEM_BRANCH },
    ...{ timestamp: '2026-10-01T08:00:00Z', nonce: randomBytes(16).toString('hex') },
  };
  const body = renderComment(approved, sign(approved, owner.privateKey, { stdinIsTTY: true }));
  seedState({
    repos: {
      [REPO]: {
        origin: repo.origin,
        labels: ['owner:approved', 'owner:waiver', 'pause:line', 'tier:2'].map((name) => ({
          ...{ name, color: 'ededed', description: '' },
        })),
        issues: [
          { number: 1, title: 'Owner inbox', events: o.inbox ?? [] },
          {
            number: ITEM,
            title: 'Add login',
            labels: o.labels ?? [
              `tier:${String(tier ?? 2)}`,
              ...(tier === null ? [] : ['owner:approved']),
            ],
            ...(tier === null
              ? {}
              : {
                  comments: [{ id: 900, author: 'owner', body, createdAt: approved.timestamp }],
                  events: [labeledAt('owner:approved', '2026-10-01T08:01:00Z')],
                }),
          },
        ],
        prs: [
          {
            ...{ number: ITEM_PR, headRefName: branchName },
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
      ask: (question) => {
        asked.push(question);
        return Promise.resolve(answers.shift() ?? '');
      },
    });
    return { code, stdout: out.join(''), stderr: err.join('') };
  };
  const mainOnOrigin = () => runGit(repo.origin, ['rev-parse', 'main']);
  /** Origin shows as the factory repository on GitHub; fetches still reach the bare origin. */
  const asFactoryRepository = (): CliOver => {
    const url = `https://github.com/${FACTORY_REPO}.git`;
    repo.git(['remote', 'set-url', 'origin', url]);
    const global = join(home, 'gitconfig');
    writeFileSync(global, `[url "${repo.origin}"]\n\tinsteadOf = ${url}\n`);
    return { env: { GIT_CONFIG_GLOBAL: global } };
  };
  return { repo, head, home, cli, asked, mainOnOrigin, asFactoryRepository };
}

interface CliOver {
  answers?: string[];
  env?: NodeJS.ProcessEnv;
  tty?: boolean;
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

      expect(r.stderr).toContain(NOT_YET);
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
      expect(declined.stderr).not.toContain(NOT_YET);
      expect(t.asked).toHaveLength(2);
      expect(confirmed.stderr).toContain(NOT_YET);
    });

    it('warns while the dispatcher shows a session running for the item, and goes on only after the Owner confirms (AC-088)', async () => {
      const t = mergeSetup();
      t.repo.checkout(ITEM_BRANCH);
      const manifest = { item: ITEM, station: 4, role: 'builder', branch: ITEM_BRANCH };
      t.repo.commit(
        { 'specs/7-add-login/.station.json': `${JSON.stringify(manifest)}\n` },
        'Dispatcher: station 4 (builder) manifest',
      );
      t.repo.push(ITEM_BRANCH);
      t.repo.checkout('main');

      const declined = await t.cli(['merge', String(ITEM_PR)], { answers: [''] });
      const confirmed = await t.cli(['merge', String(ITEM_PR)], { answers: ['yes'] });

      expect(declined.code).toBe(1);
      expect(declined.stderr).toMatch(/warning: .*session.*station 4/);
      expect(declined.stderr).not.toContain(NOT_YET);
      expect(confirmed.stderr).toContain(NOT_YET);
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
      expect(r.stderr).not.toContain(NOT_YET);
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
      expect(there.stderr).toContain(NOT_YET);
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
      expect(two.stderr).toContain(NOT_YET);
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
      expect(r.stderr).toContain(NOT_YET);
    });
  },
);
