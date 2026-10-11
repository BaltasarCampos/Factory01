// `factory merge` and `factory deploy` (T053). Slice 21 writes the per-branch rule cases
// (AC-081–AC-083, AC-086, FR-016g) against src/merge/rules.ts, with the inputs `factory merge`
// will pass in; the command's own cases come with slices 22a, 22b and 23a.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReleaseKeys } from '../../src/approvals/keys.js';
import { renderComment } from '../../src/approvals/record.js';
import { sign } from '../../src/approvals/sign.js';
import { serialiseManifest } from '../../src/install/manifest.js';
import {
  mergeRules,
  originRepo,
  releaseSource,
  type MergeRulesInput,
  type PullRequest,
} from '../../src/merge/rules.js';
import type { ApprovalRecord } from '../../src/model/types.js';
import { makeRepo, type Files, type TestRepo } from '../helpers/git-repo.js';
import { manifestOf } from '../helpers/guardrails.js';
import { makeKeys, makeOtherKeys, writeKeyFiles, type TestKeys } from '../helpers/keys.js';

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
