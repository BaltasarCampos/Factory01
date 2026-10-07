import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderComment } from '../../src/approvals/record.js';
import { sign } from '../../src/approvals/sign.js';
import {
  dispatchOnce,
  type DispatchContext,
  type DispatchEvent,
} from '../../src/dispatcher/dispatch.js';
import { selectLauncher } from '../../src/dispatcher/launcher/select.js';
import { RefusedError } from '../../src/cli/env.js';
import { verifiedMerges } from '../../src/git/merges.js';
import { STATES, STATIONS, type ApprovalRecord } from '../../src/model/types.js';
import { FakeLauncher } from '../helpers/fake-launcher.js';
import { readState, seedState, type FakeIssue } from '../helpers/fake-gh.js';
import { gitEnv, makeRepo, mergeBrief, type TestRepo } from '../helpers/git-repo.js';
import { makeKeys, makeOtherKeys, tempDir, writeKeyFiles, type TestKeys } from '../helpers/keys.js';

const REPO = 'owner/project';
const INBOX = 1;
const PIN = `v1.0.0@${'a'.repeat(40)}`;
const LABELS = [
  ...STATES.map((s) => `state:${s}`),
  'owner:approved',
  'owner:spec-approved',
  'owner:waiver',
  'pause:line',
  ...STATIONS.map((s) => `pause:${s}`),
].map((name) => ({ name, color: 'ededed', description: '' }));
const BEFORE = '2026-10-01T08:00:00Z';
const LATER = '2026-10-01T08:05:00Z';

let owner: TestKeys;
let other: TestKeys;
/** An Owner key the pinned release lists and revokes. */
let revoked: TestKeys;
beforeAll(() => {
  owner = makeKeys();
  other = makeOtherKeys();
  revoked = makeKeys();
});

type Approval =
  | 'signed'
  | 'label without a record'
  | 'record signed by another key'
  | 'record copied from another issue';

interface ItemSeed {
  number: number;
  author?: string;
  /** Current `state:` labels, added before anything else. */
  states?: string[];
  approval?: Approval;
  /** Other labels, e.g. a proposed `tier:`. */
  labels?: string[];
}

const labeled = (name: string, at: string) => ({
  event: 'labeled' as const,
  label: { name },
  actor: { login: 'owner' },
  created_at: at,
});

function approvalBody(repo: string, issue: number, key: TestKeys): string {
  const record: ApprovalRecord = {
    repo,
    issue,
    gate: 'approved',
    tier: 2,
    branch: `claude/${String(issue)}-add-login`,
    timestamp: BEFORE,
    nonce: randomBytes(16).toString('hex'),
  };
  return renderComment(record, sign(record, key.privateKey, { stdinIsTTY: true }));
}

function issue(repo: string, seed: ItemSeed): Partial<FakeIssue> & { number: number } {
  const states = seed.states ?? [];
  const labels = [...states, ...(seed.labels ?? [])];
  const events = states.map((s) => labeled(s, BEFORE));
  const comments: FakeIssue['comments'] = [];
  if (seed.approval !== undefined) {
    if (seed.approval !== 'label without a record') {
      const key = seed.approval === 'record signed by another key' ? other : owner;
      const forIssue =
        seed.approval === 'record copied from another issue' ? seed.number + 100 : seed.number;
      const body = approvalBody(repo, forIssue, key);
      comments.push({ id: 5000 + seed.number, author: 'owner', body, createdAt: BEFORE });
    }
    labels.push('owner:approved');
    events.push(labeled('owner:approved', LATER));
  }
  return { number: seed.number, author: seed.author ?? 'owner', labels, events, comments };
}

interface Setup {
  repo?: string;
  visibility?: 'private' | 'public';
  /** Lines appended to `.factory/config`; default `agents: cloud`. */
  config?: string;
  inboxLabels?: string[];
  secondCopy?: () => string;
  /** How main's history reaches the dispatcher; default an Owner-signed Define merge. */
  brief?: Brief;
  /** One of main's pinned key lists cannot be read. */
  unreadable?: 'allowedSigners' | 'revokedKeys';
}

type Brief =
  | 'signed'
  | 'signed after the baseline'
  | 'not merged'
  | 'on an unsigned commit'
  | 'on an agent commit'
  | 'signed with a revoked key'
  | 'after an unsigned commit';

/** Main's first-parent history: a signed root, or an unsigned one recorded as `baseline`. */
function mainHistory(config: string, brief: Brief): TestRepo {
  if (brief === 'signed after the baseline') {
    const project = makeRepo({ files: { 'README.md': 'old\n' } });
    const baseline = `baseline: ${project.revParse('HEAD')}\n`;
    project.commit({ '.factory/config': config + baseline }, 'adopt', { signWith: owner });
    mergeBrief(project, { signWith: owner });
    return project;
  }
  const project = makeRepo({ files: { '.factory/config': config }, signWith: owner });
  if (brief === 'after an unsigned commit') project.commit({ 'x.md': 'x\n' }, 'unsigned');
  const signers: Partial<Record<Brief, TestKeys>> = {
    'on an agent commit': other,
    'signed with a revoked key': revoked,
  };
  if (brief !== 'not merged')
    mergeBrief(
      project,
      brief === 'on an unsigned commit' ? {} : { signWith: signers[brief] ?? owner },
    );
  return project;
}

function setup(items: ItemSeed[], options: Setup = {}) {
  const repo = options.repo ?? REPO;
  const inboxLabels = options.inboxLabels ?? [];
  seedState({
    repos: {
      [repo]: {
        visibility: options.visibility ?? 'private',
        labels: LABELS,
        issues: [
          {
            number: INBOX,
            title: 'Owner inbox',
            labels: inboxLabels,
            events: inboxLabels.map((l) => labeled(l, BEFORE)),
          },
          ...items.map((seed) => issue(repo, seed)),
        ],
      },
    },
  });
  const config = `factory_release: ${PIN}\nrepo: ${repo}\ninbox_issue: ${String(INBOX)}\n`;
  const project = mainHistory(
    config + (options.config ?? 'agents: cloud\n'),
    options.brief ?? 'signed',
  );
  const keys = writeKeyFiles([revoked, owner], [revoked]);
  if (options.unreadable !== undefined) keys[options.unreadable] = join(tempDir(), 'missing');
  const cloud = new FakeLauncher('cloud');
  const local = new FakeLauncher('local');
  const logged: [number, DispatchEvent][] = [];
  const ctx: DispatchContext = {
    projectDir: project.path,
    keysFor: () => keys,
    secondCopy: options.secondCopy?.() ?? owner.publicKey,
    historySigned: () => Promise.resolve(true),
    gatherEvidence: () => Promise.resolve({ needsSession: true }),
    launchers: { cloud, local },
    logEvent: (n, event) => {
      logged.push([n, event]);
      return Promise.resolve();
    },
  };
  const state = () => {
    const r = readState().repos[repo];
    if (r === undefined) throw new Error(`no ${repo}`);
    return r;
  };
  const labelsOf = (n: number) => state().issues.find((i) => i.number === n)?.labels ?? [];
  const inbox = () => state().issues.find((i) => i.number === INBOX)?.comments ?? [];
  return {
    ctx,
    cloud,
    local,
    logged,
    labelsOf,
    inbox,
    runs: () => state().workflowRuns,
    project,
    keys,
  };
}

describe('dispatcher core: admission (AC-008, AC-055)', () => {
  it.each([
    ['private project repository', 'owner/project', 'private'],
    ['public factory repository', 'owner/factory', 'public'],
  ] as const)(
    'never picks an issue without a verified owner:approved, even one the Owner wrote, in the %s (AC-008, AC-055)',
    async (_name, repo, visibility) => {
      const items = [
        { number: 2, author: 'stranger' },
        { number: 3, author: 'stranger', states: ['state:building'] },
        { number: 4 },
        { number: 5, approval: 'signed' as const },
      ];
      const t = setup(items, { repo, visibility });

      const result = await dispatchOnce(t.ctx);

      expect(result.skipped.map((s) => s.issue)).toEqual([2, 3, 4]);
      expect(result.skipped[2]?.reason).toMatch(/no verified owner:approved/);
      expect(t.labelsOf(2)).toEqual([]);
      expect(t.labelsOf(3)).toEqual(['state:building']);
      expect(t.labelsOf(4)).toEqual([]);
      expect(t.cloud.launches).toEqual([expect.objectContaining({ item: 5, role: 'spec' })]);
      expect(t.inbox()).toEqual([]);
    },
  );

  it('admits a non-Owner issue once a verified owner:approved covers it, and starts Specify on the record branch (AC-008)', async () => {
    const t = setup([{ number: 2, author: 'stranger', approval: 'signed' }]);

    const result = await dispatchOnce(t.ctx);

    expect(result.moves).toEqual([
      expect.objectContaining({ issue: 2, from: 'new', to: 'triaged' }),
    ]);
    expect(t.labelsOf(2)).toContain('state:triaged');
    expect(t.cloud.launches).toEqual([
      expect.objectContaining({ item: 2, role: 'spec', station: 2, branch: 'claude/2-add-login' }),
    ]);
  });

  it('holds an approved item while its proposed tier: is above the confirmed tier (AC-009)', async () => {
    // The record confirms tier 2; Intake or the filing agent proposes tier 3.
    const t = setup([{ number: 2, approval: 'signed', labels: ['tier:3'] }]);

    const result = await dispatchOnce(t.ctx);

    expect(result.moves).toEqual([]);
    expect(t.labelsOf(2)).not.toContain('state:triaged');
    // It stays in `new`: no Specify session (whether Intake has work left is T060's evidence).
    expect(t.cloud.launches.map((l) => l.role)).not.toContain('spec');
  });

  it('starts no session for a state whose Owner gates do not hold (forged state: label)', async () => {
    const t = setup([{ number: 2, states: ['state:building'] }]);

    const result = await dispatchOnce(t.ctx);

    expect(result.moves).toEqual([]);
    expect(result.launched).toBeUndefined();
    expect(t.cloud.launches).toEqual([]);
  });
});

describe('dispatcher core: launcher selection (AC-002)', () => {
  it('selectLauncher uses the launcher agents names and refuses when agents is unset (AC-002)', () => {
    const cloud = new FakeLauncher('cloud');
    const local = new FakeLauncher('local');
    expect(selectLauncher({ repo: REPO, agents: 'cloud' }, { cloud, local })).toBe(cloud);
    expect(selectLauncher({ repo: REPO, agents: 'local' }, { cloud, local })).toBe(local);
    expect(() => selectLauncher({ repo: REPO }, { cloud, local })).toThrow(RefusedError);
    expect(() => selectLauncher({ repo: REPO }, { cloud, local })).toThrow(/agents/);
  });

  it('a config without agents makes the cloud launch refuse, with the reason shown to the Owner once (AC-002)', async () => {
    const t = setup([{ number: 2, approval: 'signed' }], { config: '' });

    const first = await dispatchOnce(t.ctx);
    const second = await dispatchOnce(t.ctx);

    expect(first.refused).toMatch(/agents/);
    expect(second.refused).toBe(first.refused);
    expect(t.cloud.launches).toEqual([]);
    expect(t.local.launches).toEqual([]);
    const alerts = t.inbox();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.body).toMatch(
      /^<!-- factory-alert id=\S+ urgency=urgent kind=consent-missing -->/,
    );
    expect(alerts[0]?.body).toMatch(/agents/);
    expect(alerts[0]?.body).toMatch(/cloud/);
  });
});

describe('dispatcher core: owner: labels (AC-068)', () => {
  it.each([
    'label without a record',
    'record signed by another key',
    'record copied from another issue',
  ] as const)(
    'owner:approved with a %s escalates the item, raises an urgent tampering alert and logs an event (AC-068)',
    async (approval) => {
      const t = setup([{ number: 2, approval }]);

      const result = await dispatchOnce(t.ctx);

      expect(result.moves).toEqual([
        expect.objectContaining({ issue: 2, from: 'new', to: 'escalated' }),
      ]);
      expect(t.labelsOf(2)).toContain('state:escalated');
      const [alert] = t.inbox();
      expect(alert?.body).toMatch(/^<!-- factory-alert id=\S+ urgency=urgent kind=tampering -->/);
      expect(alert?.body).toContain('#2');
      expect(t.runs()).toEqual([expect.objectContaining({ workflow: 'owner-alert.yml' })]);
      expect(t.logged).toEqual([
        [2, expect.objectContaining({ kind: 'alert', gate: 'approved', pass: false })],
      ]);
      expect(t.cloud.launches).toEqual([]);

      await dispatchOnce(t.ctx);
      expect(t.inbox()).toHaveLength(1);
    },
  );

  it('halts with an urgent alert when the second copy of the key differs from the newest key (AC-072)', async () => {
    const t = setup([{ number: 2, approval: 'signed' }], { secondCopy: () => other.publicKey });

    const result = await dispatchOnce(t.ctx);

    expect(result.halted).toMatch(/second copy/);
    expect(result.moves).toEqual([]);
    expect(t.cloud.launches).toEqual([]);
    expect(t.inbox()[0]?.body).toMatch(/urgency=urgent kind=tampering/);
  });
});

describe('dispatcher core: one pass', () => {
  it('starts at most one session per pass', async () => {
    const approved = [2, 3, 4].map((number) => ({ number, approval: 'signed' as const }));
    const t = setup(approved);

    const result = await dispatchOnce(t.ctx);

    expect(t.cloud.launches).toHaveLength(1);
    expect(result.launched).toEqual(
      expect.objectContaining({ issue: 2, role: 'spec', mode: 'cloud' }),
    );
  });

  it('starts nothing and moves nothing while pause:line is in effect (AC-034)', async () => {
    const t = setup([{ number: 2, author: 'stranger', approval: 'signed' }], {
      inboxLabels: ['pause:line'],
    });

    const result = await dispatchOnce(t.ctx);

    expect(result.halted).toMatch(/pause:line/);
    expect(result.moves).toEqual([]);
    expect(t.cloud.launches).toEqual([]);
  });
});

describe('dispatcher core: nothing is admitted before the brief is merged (AC-006)', () => {
  it.each([
    'not merged',
    'on an unsigned commit',
    'on an agent commit',
    'signed with a revoked key',
    'after an unsigned commit',
  ] as const)('a Factory-Merge: define %s admits no item', async (brief) => {
    const t = setup([{ number: 2, approval: 'signed' }], { brief });

    const result = await dispatchOnce(t.ctx);

    expect(result.skipped).toEqual([
      { issue: 2, reason: expect.stringMatching(/merge the Define pull request/) as string },
    ]);
    expect(result.moves).toEqual([]);
    expect(t.cloud.launches).toEqual([]);
  });

  it('a Factory-Merge: define merge with a good signature by a key not in allowed_signers does not count', () => {
    const t = setup([], { brief: 'on an agent commit' });
    const merge = t.project.revParse('main');
    // The signature is valid (U: good, unknown key); only the key is not the Owner's.
    const listed = ['-c', `gpg.ssh.allowedSignersFile=${t.keys.allowedSigners}`];
    expect(t.project.git([...listed, 'log', '-1', '--format=%G?', merge])).toBe('U');
    const trailer = '--format=%(trailers:key=Factory-Merge,valueonly)';
    expect(t.project.git(['log', '-1', trailer, merge])).toBe('define');
    expect(verifiedMerges(t.project.path, t.keys, { ref: 'main' })).toEqual({
      lastVerified: t.project.revParse('main^1'),
      merges: [],
    });
  });

  it('counts an Owner-signed Factory-Merge: define after the baseline', async () => {
    const t = setup([{ number: 2, approval: 'signed' }], { brief: 'signed after the baseline' });

    const result = await dispatchOnce(t.ctx);

    expect(result.moves).toEqual([expect.objectContaining({ issue: 2, to: 'triaged' })]);
    expect(t.cloud.launches).toEqual([expect.objectContaining({ item: 2 })]);
  });

  it('reads trailers only up to the first commit git verify-commit rejects, and names the last verified one', () => {
    const t = setup([], { brief: 'after an unsigned commit' });
    const root = t.project.revParse('main~2');
    expect(verifiedMerges(t.project.path, t.keys, { ref: 'main' })).toEqual({
      lastVerified: root,
      merges: [],
    });
    const merged = setup([]).project;
    expect(verifiedMerges(merged.path, t.keys, { ref: 'main' })).toEqual({
      lastVerified: merged.revParse('main'),
      merges: [{ commit: merged.revParse('main'), value: 'define' }],
    });
  });
});

describe('dispatcher core: fails closed when main cannot be verified (AC-006)', () => {
  it.each(['allowedSigners', 'revokedKeys'] as const)(
    'when the pinned %s cannot be read, admits nothing, moves nothing and alerts the Owner',
    async (unreadable) => {
      const t = setup([{ number: 2, approval: 'signed' }], { unreadable });

      const result = await dispatchOnce(t.ctx);

      expect(result.halted).toMatch(/cannot verify main/);
      expect(result.moves).toEqual([]);
      expect(t.cloud.launches).toEqual([]);
      expect(t.inbox()).toHaveLength(1);
      expect(t.inbox()[0]?.body).toMatch(/urgency=urgent kind=unverifiable/);
    },
  );

  it.each([
    ['git', (): string => ''],
    [
      'ssh-keygen',
      (): string => {
        const bin = tempDir('factory-bin-');
        const git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
        symlinkSync(git, join(bin, 'git'));
        return bin;
      },
    ],
  ] as const)('refuses to read trailers when %s cannot run', (program, path) => {
    const t = setup([]);
    const env = { ...gitEnv, PATH: path() };
    expect(() => verifiedMerges(t.project.path, t.keys, { ref: 'main', env })).toThrow(
      new RegExp(`cannot run ${program}`),
    );
  });
});
