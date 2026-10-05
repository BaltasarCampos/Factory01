// `factory new` / `factory adopt` (T038) with fake `gh`, temp repos and real `ssh-keygen`. The
// install steps (slice 11a): guardrails rendered from the pinned release and checked against its
// manifest, labels, the pinned inbox, `.factory/config` and the `claude/define` branch. The
// commands (slice 11b): consent first, the release tag verified with the laptop's key list, an
// Owner-signed root or adopt commit, then Define started through the launcher.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ownerKeyPath } from '../../src/approvals/sign.js';
import { runCli } from '../../src/cli/commands.js';
import { EnvironmentError, RefusedError } from '../../src/cli/env.js';
import { signedTag } from '../../src/git/sign.js';
import { createRepo } from '../../src/github/repo.js';
import { render } from '../../src/install/render.js';
import {
  buildManifest,
  fetchPinnedManifest,
  isProtected,
  ManifestError,
  serialiseManifest,
} from '../../src/install/manifest.js';
import { installLabels } from '../../src/install/labels.js';
import { createDefineBranch, installProject, runSpecifyInit } from '../../src/install/project.js';
import { parseConfig } from '../../src/model/config.js';
import { ITEM_TYPES, STATES, STATIONS, type GuardrailManifest } from '../../src/model/types.js';
import { calls, readState, seedState } from '../helpers/fake-gh.js';
import { FakeLauncher } from '../helpers/fake-launcher.js';
import { gitEnv, makeRepo, runGit } from '../helpers/git-repo.js';
import { makeKeys, makeOtherKeys, tempDir, writeKeyFiles, type TestKeys } from '../helpers/keys.js';

const FACTORY = 'owner/factory';
const PROJECT = 'owner/project';
const PIN = { tag: 'v1.0.0', sha: 'c'.repeat(40) };
const TAG_OBJECT = 'd'.repeat(40);
const SIGNATURE = '-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n';
const MCP_JSON = `${JSON.stringify(
  { mcpServers: { factory: { command: 'factory', args: ['mcp'] } } },
  null,
  2,
)}\n`;

/** The release's factory/ material, keyed by path under factory/. */
const SOURCES: Record<string, string> = {
  'roles/define.md': '---\nname: define\n---\nWork in {{repo}} only.\n',
  'roles/builder.md': '---\nname: builder\n---\nBuild.\n',
  'settings/settings.json': '{ "permissions": { "deny": ["Read(~/.factory/keys/**)"] } }\n',
  'workflows/ci.yml': 'name: ci\non: pull_request\n',
  'workflows/owner-alert.yml': 'name: owner-alert\non: workflow_dispatch\n',
  'constitution.md': '# Constitution\n\nv2.6.0\n',
  'lockfile-policy': 'npm ci --ignore-scripts\n',
  'skills/speckit-plan/SKILL.md': 'release copy of speckit-plan\n',
  'speckit/spec-template.md': '# Spec for {{repo}}\n',
};

/** Where each source lands in the project; `.mcp.json` is generated. */
const INSTALLED: Record<string, string> = {
  '.claude/agents/define.md': SOURCES['roles/define.md'] ?? '',
  '.claude/agents/builder.md': SOURCES['roles/builder.md'] ?? '',
  '.claude/settings.json': SOURCES['settings/settings.json'] ?? '',
  '.claude/skills/speckit-plan/SKILL.md': SOURCES['skills/speckit-plan/SKILL.md'] ?? '',
  '.github/workflows/ci.yml': SOURCES['workflows/ci.yml'] ?? '',
  '.github/workflows/owner-alert.yml': SOURCES['workflows/owner-alert.yml'] ?? '',
  '.specify/memory/constitution.md': SOURCES['constitution.md'] ?? '',
  '.factory/lockfile-policy': SOURCES['lockfile-policy'] ?? '',
  '.mcp.json': MCP_JSON,
};

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function expectedManifest(files = INSTALLED): GuardrailManifest {
  return {
    release: PIN.tag,
    commit: PIN.sha,
    files: Object.fromEntries(Object.entries(files).map(([p, text]) => [p, sha256(text)])),
  };
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

/** The signed tag `v1.0.0` → tag object → commit, as `gh api` returns it. */
function tagApi(
  message: string,
  { target = PIN.sha, type = 'tag' }: { target?: string; type?: string } = {},
): Record<string, unknown> {
  return {
    [`repos/${FACTORY}/git/ref/tags/${PIN.tag}`]: {
      ref: `refs/tags/${PIN.tag}`,
      object: { type, sha: type === 'tag' ? TAG_OBJECT : target },
    },
    [`repos/${FACTORY}/git/tags/${TAG_OBJECT}`]: {
      tag: PIN.tag,
      message,
      object: { type: 'commit', sha: target },
    },
  };
}

/** A fresh empty private project repo on the fake GitHub, cloned to a work tree. */
async function setup(manifest = expectedManifest()) {
  const root = tempDir('factory-install-');
  seedState({
    user: 'owner',
    gitRoot: join(root, 'github'),
    repos: {
      [FACTORY]: { visibility: 'public', api: tagApi(serialiseManifest(manifest) + SIGNATURE) },
    },
  });
  await createRepo(PROJECT);
  const work = join(root, 'work');
  runGit(root, ['clone', '-q', readState().repos[PROJECT]?.origin ?? '', work]);
  const factoryRoot = join(root, 'factory');
  writeTree(factoryRoot, SOURCES);
  return { work, factoryRoot };
}

/** Stands in for `specify init`: Spec Kit files, plus its own `.claude/` skills. */
function fakeSpecify(cwd: string): void {
  writeTree(cwd, {
    '.specify/templates/plan-template.md': '# Plan\n',
    '.specify/memory/constitution.md': '# Spec Kit default constitution\n',
    '.claude/skills/speckit-plan/SKILL.md': 'spec kit copy of speckit-plan\n',
    '.claude/skills/speckit-extra/SKILL.md': 'not in the release\n',
  });
}

function install(work: string, factoryRoot: string) {
  return installProject({
    repo: PROJECT,
    workdir: work,
    factoryRepo: FACTORY,
    factoryRoot,
    pin: PIN,
    agents: 'local',
    runSpecify: fakeSpecify,
  });
}

const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8');

describe('install steps (AC-003)', { timeout: 60_000 }, () => {
  // One install shared by the read-only checks: each runs ~30 fake `gh` processes.
  let work = '';
  let inboxIssue = 0;
  beforeAll(async () => {
    const made = await setup();
    work = made.work;
    ({ inboxIssue } = await install(work, made.factoryRoot));
  }, 60_000);

  it('AC-003: installs every guardrail byte-identical to the pinned release manifest', () => {
    for (const [rel, text] of Object.entries(INSTALLED)) expect(read(work, rel)).toBe(text);
    // The protected set is exactly the release's: Spec Kit's own `.claude/` files are gone.
    expect(buildManifest(work, PIN)).toEqual(expectedManifest());
    expect(existsSync(join(work, '.claude/skills/speckit-extra'))).toBe(false);
    expect(read(work, '.specify/memory/constitution.md')).toBe(SOURCES['constitution.md']);
    expect(read(work, '.specify/templates/plan-template.md')).toBe('# Plan\n');
  });

  it('AC-003: substitutes {{repo}} only outside guardrail files', () => {
    expect(read(work, '.claude/agents/define.md')).toContain('{{repo}}');
    expect(read(work, '.specify/templates/overrides/spec-template.md')).toBe(
      `# Spec for ${PROJECT}\n`,
    );
  });

  it('AC-003: writes .factory/config pinning <tag>@<sha> with the pinned inbox issue', () => {
    const text = read(work, '.factory/config');
    expect(text).toContain(`factory_release: v1.0.0@${PIN.sha}\n`);
    const config = parseConfig(text);
    expect(config).toMatchObject({ repo: PROJECT, agents: 'local', inbox_issue: inboxIssue });
    expect(config.baseline).toBeUndefined();

    const project = readState().repos[PROJECT];
    expect(project?.visibility).toBe('private');
    const inbox = project?.issues.find((i) => i.number === inboxIssue);
    expect(inbox).toMatchObject({ isPinned: true, state: 'OPEN', title: 'Factory inbox' });
  });

  it('AC-003: creates every owner:, state:, tier:, pause:, type: and priority: label, and none twice', async () => {
    const names = readState().repos[PROJECT]?.labels.map((l) => l.name) ?? [];
    expect(new Set(names)).toEqual(
      new Set([
        'owner:approved',
        'owner:spec-approved',
        'owner:waiver',
        ...STATES.map((s) => `state:${s}`),
        'tier:1',
        'tier:2',
        'tier:3',
        'pause:line',
        ...STATIONS.map((s) => `pause:${s}`),
        'security',
        ...ITEM_TYPES.map((t) => `type:${t}`),
        ...['p0', 'p1', 'p2', 'p3'].map((p) => `priority:${p}`),
      ]),
    );
    expect(await installLabels(PROJECT)).toEqual([]);
  });

  it('AC-003: pushes claude/define from the first commit on main', () => {
    runGit(work, ['add', '-A']);
    runGit(work, ['-c', 'user.name=o', '-c', 'user.email=o@x', 'commit', '-q', '-m', 'root']);
    runGit(work, ['push', '-q', 'origin', 'main']);

    createDefineBranch(work);
    const remote = runGit(work, ['ls-remote', 'origin', 'refs/heads/claude/define']);
    expect(remote.split(/\s/)[0]).toBe(runGit(work, ['rev-parse', 'HEAD']));
  });
});

describe('install refusals (AC-003)', { timeout: 30_000 }, () => {
  it('AC-003: one byte off the pinned manifest refuses before anything reaches GitHub', async () => {
    const tampered = expectedManifest({ ...INSTALLED, '.claude/settings.json': '{}\n' });
    const { work, factoryRoot } = await setup(tampered);

    await expect(install(work, factoryRoot)).rejects.toThrow(/\.claude\/settings\.json/);
    const project = readState().repos[PROJECT];
    expect(project?.labels).toEqual([]);
    expect(project?.issues).toEqual([]);
    expect(existsSync(join(work, '.factory/config'))).toBe(false);
  });

  it('AC-003: a release file missing from the manifest, or an extra one, refuses', async () => {
    const files: Record<string, string> = { ...INSTALLED };
    delete files['.github/workflows/ci.yml'];
    const { work, factoryRoot } = await setup(expectedManifest(files));
    await expect(install(work, factoryRoot)).rejects.toBeInstanceOf(ManifestError);

    const more = await setup(expectedManifest({ ...INSTALLED, '.claude/agents/ghost.md': 'x\n' }));
    await expect(install(more.work, more.factoryRoot)).rejects.toThrow(/ghost\.md/);
  });

  it('AC-003: refuses to install over an existing .factory/config', async () => {
    const { work, factoryRoot } = await setup();
    writeTree(work, { '.factory/config': `factory_release: v1.0.0@${PIN.sha}\n` });
    await expect(install(work, factoryRoot)).rejects.toBeInstanceOf(RefusedError);
    expect(readState().repos[PROJECT]?.labels).toEqual([]);
  });

  it('AC-003: a release without its constitution refuses before anything reaches GitHub', async () => {
    const { work, factoryRoot } = await setup();
    rmSync(join(factoryRoot, 'constitution.md'));
    await expect(install(work, factoryRoot)).rejects.toThrow(/factory\/constitution\.md/);
    expect(readState().repos[PROJECT]?.issues).toEqual([]);
  });

  it('AC-003: a missing `specify` is an environment error', () => {
    const empty = tempDir('factory-path-');
    expect(() => {
      runSpecifyInit(empty, { ...process.env, PATH: empty });
    }).toThrow(EnvironmentError);
  });
});

describe('guardrail manifest (AC-003)', { timeout: 30_000 }, () => {
  it('AC-003: hashes only the guarded paths, never .factory/config or product code', () => {
    const root = tempDir('factory-manifest-');
    writeTree(root, {
      ...INSTALLED,
      '.claude/hooks/pre.sh': 'echo\n',
      '.factory/config': 'repo: owner/project\n',
      '.gitattributes': '* -diff\n',
      'src/app.ts': 'export {};\n',
      '.specify/templates/plan-template.md': '# Plan\n',
    });
    const manifest = buildManifest(root, PIN);
    expect(Object.keys(manifest.files).sort()).toEqual(
      [...Object.keys(INSTALLED), '.claude/hooks/pre.sh'].sort(),
    );
    expect(manifest.files['.mcp.json']).toBe(sha256(MCP_JSON));
    expect(manifest).toMatchObject({ release: 'v1.0.0', commit: PIN.sha });
  });

  it('AC-003: isProtected covers hashed paths, .factory/config and any .gitattributes/.gitmodules', () => {
    for (const path of [
      '.claude/agents/define.md',
      '.claude/hooks/x',
      '.mcp.json',
      '.github/workflows/ci.yml',
      '.specify/memory/constitution.md',
      '.factory/lockfile-policy',
      '.factory/config',
      '.gitattributes',
      'src/deep/.gitattributes',
      'vendor/.gitmodules',
      './.claude/settings.json',
    ])
      expect(isProtected(path), path).toBe(true);
    for (const path of ['src/app.ts', '.factory/events/2026-10.jsonl', '.github/CODEOWNERS'])
      expect(isProtected(path), path).toBe(false);
  });

  it('AC-003: the pinned manifest is read from the signed tag object and must name the pin', async () => {
    await setup();
    expect(await fetchPinnedManifest(FACTORY, PIN)).toEqual(expectedManifest());
  });

  it('AC-003: fetchPinnedManifest refuses a moved tag, a lightweight tag and a manifest for another pin', async () => {
    const good = serialiseManifest(expectedManifest()) + SIGNATURE;
    const cases: [string, Record<string, unknown>][] = [
      ['moved', tagApi(good, { target: 'e'.repeat(40) })],
      ['lightweight', tagApi(good, { type: 'commit' })],
      [
        'other commit',
        tagApi(serialiseManifest({ ...expectedManifest(), commit: 'e'.repeat(40) }) + SIGNATURE),
      ],
      ['other release', tagApi(serialiseManifest({ ...expectedManifest(), release: 'v0.9.0' }))],
      ['not a manifest', tagApi('release v1.0.0\n' + SIGNATURE)],
    ];
    for (const [what, api] of cases) {
      seedState({ repos: { [FACTORY]: { visibility: 'public', api } } });
      await expect(fetchPinnedManifest(FACTORY, PIN), what).rejects.toBeInstanceOf(ManifestError);
    }
  });
});

// ---------------------------------------------------------------- the commands (slice 11b)

let ownerKeys: TestKeys;
beforeAll(() => {
  ownerKeys = makeKeys();
});

/** Stands in for `specify init` on PATH. */
const SPECIFY = `#!/bin/sh
mkdir -p .specify/templates .specify/memory
printf '# Plan\\n' > .specify/templates/plan-template.md
printf '# Spec Kit default\\n' > .specify/memory/constitution.md
`;

/**
 * The Owner's laptop: a factory clone whose release v1.0.0 is tagged with `tagKey` (`null`: an
 * unsigned annotated tag), the Owner key and key list in `~/.factory`, a fake `specify`, and the
 * public factory repo on the fake GitHub serving the same tag.
 */
function laptop({ tagKey }: { tagKey?: TestKeys | null } = {}) {
  const factory = makeRepo({
    files: {
      ...Object.fromEntries(Object.entries(SOURCES).map(([p, text]) => [`factory/${p}`, text])),
      allowed_signers: `${ownerKeys.allowedSignersLine}\n`,
      revoked_keys: '',
    },
  });
  const sha = factory.revParse('HEAD');
  const tree = tempDir('factory-tree-');
  render(join(factory.path, 'factory'), tree, {});
  const message = serialiseManifest(buildManifest(tree, { tag: 'v1.0.0', sha }));
  const key = tagKey === undefined ? ownerKeys : tagKey;
  if (key === null) factory.git(['tag', '-a', '-m', message, 'v1.0.0', sha]);
  else
    signedTag(
      { repo: factory.path, keyPath: key.privateKey, stdinIsTTY: true, env: gitEnv },
      'v1.0.0',
      sha,
      message,
    );
  factory.git(['remote', 'set-url', 'origin', `https://github.com/${FACTORY}.git`]);
  const tagObject = factory.revParse('refs/tags/v1.0.0');
  const body = factory.git(['cat-file', 'tag', tagObject]).split('\n\n').slice(1).join('\n\n');

  const root = tempDir('factory-laptop-');
  seedState({
    user: 'owner',
    gitRoot: join(root, 'github'),
    repos: {
      [FACTORY]: {
        visibility: 'public',
        api: {
          [`repos/${FACTORY}/git/ref/tags/v1.0.0`]: {
            ref: 'refs/tags/v1.0.0',
            object: { type: 'tag', sha: tagObject },
          },
          [`repos/${FACTORY}/git/tags/${tagObject}`]: {
            tag: 'v1.0.0',
            message: `${body}\n`,
            object: { type: 'commit', sha },
          },
        },
      },
    },
  });
  const home = join(root, 'home');
  mkdirSync(dirname(ownerKeyPath(home)), { recursive: true });
  copyFileSync(ownerKeys.privateKey, ownerKeyPath(home));
  chmodSync(ownerKeyPath(home), 0o600);
  writeFileSync(join(home, '.factory', 'allowed_signers'), `${ownerKeys.allowedSignersLine}\n`);
  const bin = join(root, 'bin');
  writeTree(bin, { specify: SPECIFY });
  chmodSync(join(bin, 'specify'), 0o755);
  const cwd = join(root, 'projects');
  mkdirSync(cwd);

  const launchers = { local: new FakeLauncher('local'), cloud: new FakeLauncher('cloud') };
  const env: NodeJS.ProcessEnv = {
    ...gitEnv,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    FAKE_GH_STATE: process.env.FAKE_GH_STATE,
    FACTORY_SOURCE: factory.path,
  };
  const cli = async (argv: string[], answer = 'local') => {
    const out: string[] = [];
    const err: string[] = [];
    const asked: { question: string; printed: string; ghCalls: string[][] }[] = [];
    const code = await runCli(argv, {
      stdout: { write: (s: string) => void out.push(s) },
      stderr: { write: (s: string) => void err.push(s) },
      env,
      stdinIsTTY: true,
      cwd,
      launchers,
      unreadAlerts: () => Promise.resolve([]),
      ask: (question) => {
        asked.push({ question, printed: out.join(''), ghCalls: calls() });
        return Promise.resolve(answer);
      },
    });
    return { code, stdout: out.join(''), stderr: err.join(''), asked };
  };
  return { cli, cwd, sha, launchers };
}

function signedBy(dir: string, commit: string, keys: TestKeys): boolean {
  const { allowedSigners } = writeKeyFiles([keys]);
  try {
    runGit(dir, ['-c', `gpg.ssh.allowedSignersFile=${allowedSigners}`, 'verify-commit', commit]);
    return true;
  } catch {
    return false;
  }
}

const touchesRepo = (ghCalls: string[][]) => ghCalls.some((c) => c[0] === 'repo');

type Laptop = ReturnType<typeof laptop>;
type CliResult = Awaited<ReturnType<Laptop['cli']>>;

describe('factory new (AC-001, AC-003)', { timeout: 120_000 }, () => {
  let made: Laptop;
  let result: CliResult;
  let work = '';
  beforeAll(async () => {
    made = laptop();
    const pitch = 'A tiny bookmark list I use from my laptop browser.';
    result = await made.cli(['new', pitch, '--name', 'sample']);
    work = join(made.cwd, 'sample');
  }, 120_000);

  it('AC-001: names the cloud VMs and asks cloud or local before any repo is created', () => {
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.asked).toHaveLength(1);
    const [consent] = result.asked;
    expect(consent?.printed).toMatch(/provider-managed cloud VMs/);
    expect(consent?.question).toMatch(/cloud.*local/);
    expect(touchesRepo(consent?.ghCalls ?? [])).toBe(false);
    expect(parseConfig(read(work, '.factory/config')).agents).toBe('local');
  });

  it('AC-003: a private repo pinned to the verified release, with inbox, labels and laptop clone', () => {
    const config = parseConfig(read(work, '.factory/config'));
    expect(config).toMatchObject({
      repo: 'owner/sample',
      factory_release: { tag: 'v1.0.0', sha: made.sha },
    });
    expect(config.baseline).toBeUndefined();
    const project = readState().repos['owner/sample'];
    expect(project?.visibility).toBe('private');
    expect(project?.issues.find((i) => i.number === config.inbox_issue)?.isPinned).toBe(true);
    expect(project?.labels.map((l) => l.name)).toContain('pause:line');
    for (const [rel, text] of Object.entries(INSTALLED)) expect(read(work, rel)).toBe(text);
    expect(runGit(work, ['status', '--porcelain'])).toBe('');
  });

  it('AC-003: main starts with one Owner-signed root commit; claude/define is pushed from it', () => {
    const head = runGit(work, ['rev-parse', 'origin/main']);
    expect(runGit(work, ['rev-list', '--parents', '-n', '1', head])).toBe(head);
    expect(runGit(work, ['rev-list', '--count', head])).toBe('1');
    expect(signedBy(work, head, ownerKeys)).toBe(true);
    expect(signedBy(work, head, makeOtherKeys())).toBe(false);
    const define = runGit(work, ['ls-remote', 'origin', 'refs/heads/claude/define']);
    expect(define.split(/\s/)[0]).toBe(head);
    expect(runGit(work, ['show', `${head}:.factory/define/pitch.md`])).toContain('bookmark list');
  });

  it('AC-003: starts Station 0 (Define) on claude/define with the chosen launcher', () => {
    expect(made.launchers.cloud.launches).toEqual([]);
    expect(made.launchers.local.launches).toMatchObject([
      { role: 'define', station: 0, branch: 'claude/define' },
    ]);
    expect(made.launchers.local.launches[0]?.prompt).toContain('.factory/define/pitch.md');
  });
});

describe('factory new refusals (AC-001, AC-083)', { timeout: 60_000 }, () => {
  it('AC-001: any answer but cloud or local creates nothing', async () => {
    const { cli, cwd, launchers } = laptop();
    const r = await cli(['new', 'A pitch', '--name', 'sample'], 'yes');
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/nothing was created/i);
    expect(readState().repos['owner/sample']).toBeUndefined();
    expect(touchesRepo(calls())).toBe(false);
    expect(existsSync(join(cwd, 'sample'))).toBe(false);
    expect(launchers.local.launches).toEqual([]);
  });

  it('AC-083: refuses a release tag unsigned or signed by a key not in the laptop key list', async () => {
    for (const tagKey of [null, makeOtherKeys()]) {
      const { cli, cwd } = laptop({ tagKey });
      const r = await cli(['new', 'A pitch', '--name', 'sample']);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/v1\.0\.0/);
      expect(touchesRepo(calls())).toBe(false);
      expect(existsSync(join(cwd, 'sample'))).toBe(false);
    }
  });
});

describe('factory adopt (AC-007, AC-064)', { timeout: 120_000 }, () => {
  const APP = 'export const app = 1;\n';
  const ATTRIBUTES = '*.ts text eol=lf\n';
  let made: Laptop;
  let first: CliResult;
  let baseline = '';
  let work = '';
  beforeAll(async () => {
    made = laptop();
    await createRepo('owner/legacy');
    const legacy = join(made.cwd, '..', 'legacy-src');
    runGit(made.cwd, ['clone', '-q', readState().repos['owner/legacy']?.origin ?? '', legacy]);
    runGit(legacy, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    writeTree(legacy, { 'src/app.ts': APP, '.gitattributes': ATTRIBUTES });
    runGit(legacy, ['add', '-A']);
    runGit(legacy, ['commit', '-q', '--no-gpg-sign', '-m', 'existing code']);
    runGit(legacy, ['push', '-q', 'origin', 'main']);
    baseline = runGit(legacy, ['rev-parse', 'HEAD']);
    await createRepo('owner/public-app');
    const state = readState();
    const open = state.repos['owner/public-app'];
    if (open) open.visibility = 'public';
    writeFileSync(process.env.FAKE_GH_STATE ?? '', JSON.stringify(state));

    first = await made.cli(['adopt', 'owner/legacy'], 'cloud');
    work = join(made.cwd, 'legacy');
  }, 120_000);

  it("AC-007: records baseline = main's last unsigned commit and signs an adopt commit after it", () => {
    expect(first.stderr).toBe('');
    expect(first.code).toBe(0);
    expect(first.asked).toHaveLength(1);
    expect(first.asked[0]?.printed).toMatch(/provider-managed cloud VMs/);
    const config = parseConfig(read(work, '.factory/config'));
    expect(config).toMatchObject({ repo: 'owner/legacy', agents: 'cloud', baseline });
    const head = runGit(work, ['rev-parse', 'origin/main']);
    expect(runGit(work, ['rev-parse', `${head}^`])).toBe(baseline);
    expect(signedBy(work, head, ownerKeys)).toBe(true);
  });

  it('AC-007: keeps the existing code and .gitattributes, and hands the code to Define', () => {
    expect(read(work, 'src/app.ts')).toBe(APP);
    expect(read(work, '.gitattributes')).toBe(ATTRIBUTES);
    for (const [rel, text] of Object.entries(INSTALLED)) expect(read(work, rel)).toBe(text);
    expect(made.launchers.local.launches).toEqual([]);
    expect(made.launchers.cloud.launches).toMatchObject([
      { role: 'define', station: 0, branch: 'claude/define' },
    ]);
    expect(made.launchers.cloud.launches[0]?.prompt).toMatch(/existing code/);
  });

  it('AC-064: adopting an adopted repo re-runs Define without reinstalling or asking', async () => {
    const head = runGit(work, ['rev-parse', 'origin/main']);
    const before = calls().length;
    const again = await made.cli(['adopt', 'owner/legacy'], 'local');
    expect(again.stderr).toBe('');
    expect(again.code).toBe(0);
    expect(again.asked).toEqual([]);
    const installs = calls()
      .slice(before)
      .filter((c) => c[0] === 'label' || (c[0] === 'issue' && c[1] === 'create'));
    expect(installs).toEqual([]);
    runGit(work, ['fetch', '-q', 'origin']);
    expect(runGit(work, ['rev-parse', 'origin/main'])).toBe(head);
    expect(made.launchers.cloud.launches).toHaveLength(2);
    expect(made.launchers.local.launches).toEqual([]);
  });

  it('AC-064: when no session can start, says so and how to start Define later', async () => {
    made.launchers.cloud.setUnavailable();
    const r = await made.cli(['adopt', 'owner/legacy']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Define was not started: the cloud launcher is not available/);
    expect(r.stderr).toContain('factory adopt owner/legacy');
    expect(made.launchers.cloud.launches).toHaveLength(2);
  });

  it('AC-007: refuses a public repository before cloning or asking', async () => {
    const r = await made.cli(['adopt', 'owner/public-app']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/public/);
    expect(r.asked).toEqual([]);
    expect(existsSync(join(made.cwd, 'public-app'))).toBe(false);
  });
});
