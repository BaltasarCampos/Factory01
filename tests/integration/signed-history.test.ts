import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mainKeys, type ReleaseKeys } from '../../src/approvals/keys.js';
import { ownerKeyPath } from '../../src/approvals/sign.js';
import { runCli } from '../../src/cli/commands.js';
import { auditMain } from '../../src/dispatcher/history-audit.js';
import { verifiedMerges } from '../../src/git/merges.js';
import { ledgerPath, verifyFirstParent, type KeysFor } from '../../src/git/history.js';
import { STATES } from '../../src/model/types.js';
import { FakeLauncher } from '../helpers/fake-launcher.js';
import { readState, seedState } from '../helpers/fake-gh.js';
import {
  gitEnv,
  makeRepo,
  mergeBrief,
  mergeIntoMain,
  runGit,
  type TestRepo,
} from '../helpers/git-repo.js';
import { makeKeys, makeOtherKeys, tempDir, writeKeyFiles, type TestKeys } from '../helpers/keys.js';

vi.setConfig({ testTimeout: 60_000 });

const REPO = 'owner/project';
const NO_RELEASE = 'a'.repeat(40);

let owner: TestKeys;
let older: TestKeys;
let other: TestKeys;
let revoked: TestKeys;
beforeAll(() => {
  owner = makeKeys();
  older = makeKeys();
  other = makeOtherKeys();
  revoked = makeKeys();
});

const config = (release = NO_RELEASE, baseline?: string) =>
  [
    `factory_release: v1.0.0@${release}`,
    `repo: ${REPO}`,
    'inbox_issue: 1',
    'agents: local',
    ...(baseline === undefined ? [] : [`baseline: ${baseline}`]),
    '',
  ].join('\n');

/** The same key lists for every pin. */
const always =
  (keys: ReleaseKeys): KeysFor =>
  () =>
    keys;

/** A project whose root commit pins `release` and is signed with `key`. */
function signedProject(key = owner, release = NO_RELEASE): TestRepo {
  return makeRepo({ files: { '.factory/config': config(release) }, signWith: key });
}

let changes = 0;
/** Signed commits on main, pushed. */
function grow(project: TestRepo, count: number, key = owner): void {
  for (let i = 0; i < count; i++) {
    const n = String(++changes);
    project.commit({ [`f${n}.md`]: `${n}\n` }, `change ${n}`, { signWith: key });
  }
  project.push('main');
}

const verify = (repo: string, baseline: string | undefined, keysFor: KeysFor, ledger?: string) =>
  verifyFirstParent(repo, baseline, keysFor, {
    ref: 'origin/main',
    env: gitEnv,
    ...(ledger === undefined ? {} : { ledger }),
  });

/** An adopted project: an unsigned commit, then the Owner-signed adopt commit after it. */
function adopted(key = owner, release = NO_RELEASE): { project: TestRepo; baseline: string } {
  const project = makeRepo({ files: { 'README.md': `old ${String(++changes)}\n` } });
  const baseline = project.revParse('HEAD');
  project.commit({ '.factory/config': config(release, baseline) }, 'adopt', { signWith: key });
  project.push('main');
  return { project, baseline };
}

/** The commit the ledger last recorded. */
const ledgerCommit = (path: string) =>
  /^commit ([0-9a-f]{40})$/m.exec(readFileSync(path, 'utf8'))?.[1];

/** A laptop home whose own key lists (`factory keygen`) hold `keys` and revoke `revokedKeys`. */
function laptop(keys: TestKeys[], revokedKeys: TestKeys[] = []): string {
  const home = tempDir('factory-home-');
  mkdirSync(join(home, '.factory'), { recursive: true });
  const lines = (list: string[]) => list.map((l) => `${l}\n`).join('');
  writeFileSync(
    join(home, '.factory', 'allowed_signers'),
    lines(keys.map((k) => k.allowedSignersLine)),
  );
  writeFileSync(join(home, '.factory', 'revoked_keys'), lines(revokedKeys.map((k) => k.publicKey)));
  return home;
}

describe('signed main history: verifyFirstParent (T134, T139, FR-016g)', () => {
  it('passes when every first-parent commit from the root is Owner-signed, merges included', () => {
    const project = signedProject();
    grow(project, 2);
    // The Define branch's own commit is unsigned; only first-parent commits count.
    mergeBrief(project, { signWith: owner });

    expect(verify(project.path, undefined, always(writeKeyFiles([owner])))).toEqual({
      ok: true,
      head: project.revParse('main'),
    });
  });

  it('after the baseline, ignores the unsigned commits before it', () => {
    const { project, baseline } = adopted();
    grow(project, 1);

    const result = verify(project.path, baseline, always(writeKeyFiles([owner])));

    expect(result).toEqual({ ok: true, head: project.revParse('main') });
  });

  it('accepts commits signed with an older key the release still lists', () => {
    const project = signedProject(older);
    grow(project, 1, owner);

    const keys = writeKeyFiles([older, owner]);

    expect(verify(project.path, undefined, always(keys)).ok).toBe(true);
  });

  it.each([
    ['an unsigned commit', undefined],
    ["a merge signed by another key, as GitHub's merge button makes", 'other'],
    ['a commit signed with a revoked key', 'revoked'],
  ] as const)('fails on %s and names it (AC-073, AC-087)', (_name, signer) => {
    const project = signedProject();
    const key = signer === 'other' ? other : signer === 'revoked' ? revoked : undefined;
    const bad =
      signer === 'other'
        ? mergeBrief(project, { signWith: other })
        : project.commit({ 'x.md': 'x\n' }, 'pushed', key === undefined ? {} : { signWith: key });
    project.push('main');
    grow(project, 1);

    const keys = writeKeyFiles([revoked, owner], [revoked]);

    expect(verify(project.path, undefined, always(keys))).toEqual({
      ok: false,
      commit: bad,
      reason: expect.stringMatching(/not signed by a listed, non-revoked Owner key/) as string,
    });
  });

  it('checks each commit with the pin in its first parent, so no commit can repoint the pin to keys that accept it', () => {
    // Two releases: the second also lists `other`.
    const keysBySha = new Map<string, ReleaseKeys>([
      ['1'.repeat(40), writeKeyFiles([owner])],
      ['2'.repeat(40), writeKeyFiles([owner, other])],
    ]);
    const keysFor: KeysFor = (pin) => {
      const keys = keysBySha.get(pin.sha);
      if (keys === undefined) throw new Error(`no release ${pin.sha}`);
      return keys;
    };
    const repoint = { '.factory/config': config('2'.repeat(40)) };

    const forged = signedProject(owner, '1'.repeat(40));
    const bad = forged.commit(repoint, 'repoint', { signWith: other });
    forged.push('main');
    expect(verify(forged.path, undefined, keysFor)).toMatchObject({ ok: false, commit: bad });

    // The same change signed by the Owner (an upgrade) lets the new key sign what follows.
    const upgraded = signedProject(owner, '1'.repeat(40));
    upgraded.commit(repoint, 'upgrade', { signWith: owner });
    grow(upgraded, 1, other);
    expect(verify(upgraded.path, undefined, keysFor).ok).toBe(true);
  });

  it('refuses a baseline that is not on main', () => {
    const project = signedProject();
    const keys = always(writeKeyFiles([owner]));
    expect(() => verify(project.path, 'b'.repeat(40), keys)).toThrow(/baseline/);
  });

  it('refuses a baseline that already has .factory/config, so no commit can start the chain at itself', () => {
    // An unsigned commit names its parent as baseline and pins a release that lists `other`.
    const project = signedProject();
    const parent = project.revParse('HEAD');
    project.commit({ '.factory/config': config('2'.repeat(40), parent) }, 'rebase the chain', {
      signWith: other,
    });
    project.push('main');

    const keys = always(writeKeyFiles([owner, other]));

    expect(() => verify(project.path, parent, keys)).toThrow(/baseline .* has \.factory\/config/);
  });

  it('refuses a baseline older than where adoption happened', () => {
    const project = makeRepo({ files: { 'README.md': 'old\n' } });
    const preAdoption = project.revParse('HEAD');
    project.commit({ 'src/a.ts': 'export {};\n' }, 'old work, unsigned');
    project.commit({ '.factory/config': config(NO_RELEASE, preAdoption) }, 'adopt', {
      signWith: owner,
    });
    project.push('main');

    const keys = always(writeKeyFiles([owner]));

    expect(() => verify(project.path, preAdoption, keys)).toThrow(/not where adoption happened/);
  });
});

describe('signed main history: shallow clones are deepened (T139)', () => {
  const shallowClone = (project: TestRepo): string => {
    const clone = join(tempDir('factory-shallow-'), 'clone');
    runGit(project.path, ['clone', '-q', '--depth', '1', `file://${project.origin}`, clone]);
    expect(runGit(clone, ['rev-parse', '--is-shallow-repository'])).toBe('true');
    return clone;
  };

  it('deepens to the baseline and verifies every commit after it', () => {
    const { project, baseline } = adopted();
    grow(project, 6);
    const clone = shallowClone(project);

    const result = verify(clone, baseline, always(writeKeyFiles([owner])));

    expect(result).toEqual({ ok: true, head: project.revParse('main') });
    expect(runGit(clone, ['cat-file', '-t', baseline])).toBe('commit');
  });

  it('without a baseline, deepens to the root and still finds an unsigned commit beyond the first fetch', () => {
    const project = signedProject();
    const bad = project.commit({ 'x.md': 'x\n' }, 'unsigned');
    grow(project, 4);
    const clone = shallowClone(project);

    const result = verify(clone, undefined, always(writeKeyFiles([owner])));

    expect(result).toMatchObject({ ok: false, commit: bad });
  });

  it('verifiedMerges reads a shallow clone instead of failing', () => {
    const project = signedProject();
    mergeBrief(project, { signWith: owner });
    grow(project, 3);
    const clone = shallowClone(project);

    const history = verifiedMerges(clone, always(writeKeyFiles([owner])), { env: gitEnv });

    expect(history.merges.map((m) => m.value)).toEqual(['define']);
    expect(history.lastVerified).toBe(project.revParse('main'));
  });
});

describe('signed main history: the laptop ledger (T139)', () => {
  it('records the last verified commit and verifies only what came after it', () => {
    const project = signedProject();
    grow(project, 2);
    const ledger = ledgerPath(tempDir('factory-home-'), REPO);

    expect(verify(project.path, undefined, always(writeKeyFiles([owner])), ledger).ok).toBe(true);
    expect(ledgerCommit(ledger)).toBe(project.revParse('main'));

    // Key lists that reject every commit but the new one: only the new one is checked.
    grow(project, 1, other);
    const onlyOther = always(writeKeyFiles([other]));
    expect(verify(project.path, undefined, onlyOther).ok).toBe(false);
    expect(verify(project.path, undefined, onlyOther, ledger)).toEqual({
      ok: true,
      head: project.revParse('main'),
    });
    expect(ledgerCommit(ledger)).toBe(project.revParse('main'));
  });

  it('fails when main no longer contains the commit the ledger last verified', () => {
    const project = signedProject();
    grow(project, 2);
    const ledger = ledgerPath(tempDir('factory-home-'), REPO);
    const keys = always(writeKeyFiles([owner]));
    expect(verify(project.path, undefined, keys, ledger).ok).toBe(true);
    const verified = project.revParse('main');

    // main is rewritten with Owner-signed commits that drop the last one.
    project.git(['reset', '-q', '--hard', 'HEAD~1']);
    project.commit({ 'y.md': 'y\n' }, 'rewritten', { signWith: owner });
    project.push('main', { force: true });

    expect(verify(project.path, undefined, keys, ledger)).toEqual({
      ok: false,
      commit: verified,
      reason: expect.stringMatching(/no longer contains/) as string,
    });
  });

  it('a clone behind the ledger fetches and walks once more instead of reporting a rewrite', () => {
    const project = signedProject();
    grow(project, 1);
    const behind = join(tempDir('factory-clone-'), 'clone');
    runGit(project.path, ['clone', '-q', `file://${project.origin}`, behind]);
    // Another clone verifies a newer main and records it.
    grow(project, 2);
    const ledger = ledgerPath(tempDir('factory-home-'), REPO);
    const keys = always(writeKeyFiles([owner]));
    expect(verify(project.path, undefined, keys, ledger).ok).toBe(true);

    expect(verify(behind, undefined, keys, ledger)).toEqual({
      ok: true,
      head: project.revParse('main'),
    });
  });

  it('refuses, without calling it tampering, when main is still behind the ledger after a fetch', () => {
    const project = signedProject();
    grow(project, 2);
    const ledger = ledgerPath(tempDir('factory-home-'), REPO);
    const keys = always(writeKeyFiles([owner]));
    expect(verify(project.path, undefined, keys, ledger).ok).toBe(true);
    // origin's main goes back to an ancestor of the recorded commit.
    project.git(['push', '-q', '-f', 'origin', 'main~1:main']);

    expect(() => verify(project.path, undefined, keys, ledger)).toThrow(
      'this clone is behind the ledger; fetch first',
    );
  });

  it('records only main: a walk of another ref with the ledger is refused', () => {
    const project = signedProject();
    const ledger = ledgerPath(tempDir('factory-home-'), REPO);
    const keys = always(writeKeyFiles([owner]));
    const walk = () =>
      verifyFirstParent(project.path, undefined, keys, { ref: 'main', ledger, env: gitEnv });

    expect(walk).toThrow(/ledger .* origin\/main/);
    expect(existsSync(ledger)).toBe(false);
  });

  it('records the baseline, and refuses another one later even where adoption happened', () => {
    const ledger = ledgerPath(tempDir('factory-home-'), REPO);
    const keys = always(writeKeyFiles([owner]));
    const first = adopted();
    expect(verify(first.project.path, first.baseline, keys, ledger).ok).toBe(true);
    expect(readFileSync(ledger, 'utf8')).toContain(`baseline ${first.baseline}`);

    // Another history of the same repository, adopted at another commit.
    const second = adopted();

    expect(verify(second.project.path, second.baseline, keys, ledger)).toEqual({
      ok: false,
      commit: first.project.revParse('main'),
      reason: expect.stringMatching(
        new RegExp(`baseline ${second.baseline}.*${first.baseline}`),
      ) as string,
    });
  });
});

describe('signed main history: mainKeys reads the pin at the last verified commit (T139)', () => {
  it('ignores a pin changed by an unsigned commit on main', () => {
    const factory = makeRepo({
      files: { allowed_signers: `${owner.allowedSignersLine}\n`, revoked_keys: '' },
    });
    const first = factory.revParse('HEAD');
    factory.commit({ allowed_signers: `${other.allowedSignersLine}\n` }, 'another key');
    const second = factory.revParse('HEAD');
    const project = signedProject(owner, first);
    project.commit({ '.factory/config': config(second) }, 'repoint, unsigned');
    project.push('main');
    const home = laptop([owner]);
    const env = { ...gitEnv, FACTORY_SOURCE: factory.path };

    const keys = mainKeys(project.path, env, tempDir('factory-keys-'), home);

    expect(readFileSync(keys.allowedSigners, 'utf8')).toBe(`${owner.allowedSignersLine}\n`);
    expect(ledgerCommit(ledgerPath(home, REPO))).toBe(project.revParse('main~1'));
  });

  it('on the laptop, the adopt commit must be signed by a key the laptop lists and has not revoked', () => {
    // An old release that still lists `older`; the laptop has revoked it since.
    const factory = makeRepo({
      files: {
        allowed_signers: `${older.allowedSignersLine}\n${owner.allowedSignersLine}\n`,
        revoked_keys: '',
      },
    });
    const { project } = adopted(older, factory.revParse('HEAD'));
    const env = { ...gitEnv, FACTORY_SOURCE: factory.path };
    const run = (home: string) => mainKeys(project.path, env, tempDir('factory-keys-'), home);

    expect(() => run(laptop([older, owner], [older]))).toThrow(
      /main has no Owner-signed commit: .* the laptop's own key lists/,
    );
    expect(() => run(laptop([owner]))).toThrow(/the laptop's own key lists/);
    expect(existsSync(run(laptop([older, owner])).allowedSigners)).toBe(true);
  });
});

describe('dispatcher history audit (T134, AC-073, AC-087, AC-088)', () => {
  const LABELS = [...STATES.map((s) => `state:${s}`), 'owner:approved'].map((name) => ({
    name,
    color: 'ededed',
    description: '',
  }));

  function setup() {
    const factory = makeRepo({
      files: { allowed_signers: `${owner.allowedSignersLine}\n`, revoked_keys: '' },
    });
    const project = signedProject(owner, factory.revParse('HEAD'));
    mergeBrief(project, { signWith: owner });
    seedState({
      repos: {
        [REPO]: {
          origin: project.origin,
          labels: LABELS,
          issues: [{ number: 1, title: 'Owner inbox' }],
        },
      },
    });
    const home = tempDir('factory-home-');
    mkdirSync(join(home, '.factory', 'keys'), { recursive: true });
    copyFileSync(owner.publicKeyPath, `${ownerKeyPath(home)}.pub`);
    const local = new FakeLauncher('local');
    const dispatch = async () => {
      const out: string[] = [];
      // process.env after gitEnv: it carries the fake gh state seeded above.
      const env: NodeJS.ProcessEnv = {
        ...{ ...gitEnv, ...process.env },
        ...{ HOME: home, FACTORY_SOURCE: factory.path },
      };
      delete env.CLAUDE_CODE_REMOTE;
      await runCli(['dispatch'], {
        stdout: { write: (s: string) => void out.push(s) },
        stderr: { write: (s: string) => void out.push(s) },
        ...{ env, stdinIsTTY: false, cwd: project.path, launchers: { local } },
        unreadAlerts: () => Promise.resolve([]),
      });
      return out.join('');
    };
    const inbox = () => readState().repos[REPO]?.issues.find((i) => i.number === 1)?.comments ?? [];
    return { project, dispatch, inbox, local };
  }

  it('an unsigned first-parent commit raises one urgent tampering alert naming it and moves nothing', async () => {
    const t = setup();
    const bad = t.project.commit({ 'x.md': 'merge button\n' }, 'unsigned');
    t.project.push('main');

    const first = await t.dispatch();
    await t.dispatch();

    expect(first).toContain('halted: main has a first-parent commit not signed by the Owner');
    expect(t.inbox()).toHaveLength(1);
    expect(t.inbox()[0]?.body).toMatch(/urgency=urgent kind=tampering/);
    expect(t.inbox()[0]?.body).toContain(bad);
    expect(t.local.launches).toEqual([]);
  });

  it('a push that recreates a merged and deleted item branch raises a tampering alert', async () => {
    const t = setup();
    const branch = 'claude/2-add-login';
    t.project.checkout(branch, { create: true });
    t.project.commit({ 'src/login.ts': 'export {};\n' }, 'login');
    mergeIntoMain(t.project, branch, '#2', { signWith: owner });
    const history = () =>
      verifiedMerges(t.project.path, always(writeKeyFiles([owner])), { env: gitEnv });
    expect(auditMain(t.project.path, 'origin/main', history(), gitEnv)).toEqual({ recreated: [] });

    t.project.push(branch);

    expect(auditMain(t.project.path, 'origin/main', history(), gitEnv)).toEqual({
      recreated: [branch],
    });
    await t.dispatch();
    const alerts = t.inbox().map((c) => c.body);
    expect(alerts).toEqual([expect.stringMatching(/urgency=urgent kind=tampering/) as string]);
    expect(alerts[0]).toContain(`${branch} was pushed again after #2 was merged`);
  });

  it('the ledger is laptop state under ~/.factory/verified/<owner>/<repo>', () => {
    const home = tempDir('factory-home-');
    expect(ledgerPath(home, REPO)).toBe(join(home, '.factory', 'verified', 'owner', 'project'));
    expect(existsSync(ledgerPath(home, REPO))).toBe(false);
  });
});
