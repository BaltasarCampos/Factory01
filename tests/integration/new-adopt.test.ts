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
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ownerKeyPath } from '../../src/approvals/sign.js';
import { runCli } from '../../src/cli/commands.js';
import { claudeMdShown } from '../../src/commands/adopt.js';
import { RefusedError } from '../../src/cli/env.js';
import { signedTag } from '../../src/git/sign.js';
import { createRepo } from '../../src/github/repo.js';
import { render } from '../../src/install/render.js';
import {
  buildManifest,
  coversHashed,
  fetchPinnedManifest,
  importsOutside,
  isHashed,
  isProtected,
  ManifestError,
  serialiseManifest,
} from '../../src/install/manifest.js';
import { installLabels } from '../../src/install/labels.js';
import { createDefineBranch, installProject } from '../../src/install/project.js';
import { parseConfig } from '../../src/model/config.js';
import { ITEM_TYPES, STATES, STATIONS, type GuardrailManifest } from '../../src/model/types.js';
import { calls, readState, seedState } from '../helpers/fake-gh.js';
import { FakeLauncher } from '../helpers/fake-launcher.js';
import { gitEnv, makeRepo, runGit } from '../helpers/git-repo.js';
import { workingRelease } from '../helpers/release.js';
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
  'specify/templates/spec-template.md': '# Spec for {{repo}}\n',
  'specify/templates/checklist-template.md': '# Checklist\n',
  'prompts/station-0-define.md': workingRelease('prompts/station-0-define.md'),
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
  '.specify/templates/spec-template.md': SOURCES['specify/templates/spec-template.md'] ?? '',
  '.specify/templates/checklist-template.md':
    SOURCES['specify/templates/checklist-template.md'] ?? '',
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

/** What a repository may already hold from Spec Kit's own `specify init`. */
const SPEC_KIT_LEFTOVERS = {
  '.specify/memory/constitution.md': '# Spec Kit default constitution\n',
  '.claude/skills/speckit-plan/SKILL.md': 'spec kit copy of speckit-plan\n',
  '.claude/skills/speckit-extra/SKILL.md': 'not in the release\n',
  '.specify/scripts/bash/common.sh': 'echo spec kit\n',
};

function install(work: string, factoryRoot: string) {
  return installProject({
    repo: PROJECT,
    workdir: work,
    factoryRepo: FACTORY,
    factoryRoot,
    pin: PIN,
    agents: 'local',
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
    writeTree(work, SPEC_KIT_LEFTOVERS);
    ({ inboxIssue } = await install(work, made.factoryRoot));
  }, 60_000);

  it('AC-003: installs every guardrail byte-identical to the pinned release manifest', () => {
    for (const [rel, text] of Object.entries(INSTALLED)) expect(read(work, rel)).toBe(text);
    // The protected set is exactly the release's: Spec Kit's own `.claude/` files are gone.
    expect(buildManifest(work, PIN)).toEqual(expectedManifest());
    expect(existsSync(join(work, '.claude/skills/speckit-extra'))).toBe(false);
    expect(existsSync(join(work, '.specify/scripts'))).toBe(false);
    expect(read(work, '.specify/memory/constitution.md')).toBe(SOURCES['constitution.md']);
  });

  it("T171: installs the release's .specify/ templates, with no overrides folder", () => {
    expect(read(work, '.specify/templates/checklist-template.md')).toBe('# Checklist\n');
    expect(existsSync(join(work, '.specify/templates/overrides'))).toBe(false);
  });

  it('T173: copies .specify/ byte for byte, as every guardrail file: {{repo}} is filled in none', () => {
    expect(read(work, '.claude/agents/define.md')).toContain('{{repo}}');
    expect(read(work, '.specify/templates/spec-template.md')).toBe('# Spec for {{repo}}\n');
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
});

describe('guardrail manifest (AC-003)', { timeout: 30_000 }, () => {
  it('AC-003: hashes only the guarded paths, all of .specify/ included, never .factory/config, CLAUDE.md, the brief or product code', () => {
    const root = tempDir('factory-manifest-');
    writeTree(root, {
      ...INSTALLED,
      '.claude/hooks/pre.sh': 'echo\n',
      '.factory/config': 'repo: owner/project\n',
      '.gitattributes': '* -diff\n',
      'CLAUDE.md': '# Notes\n',
      '.factory/brief.md': '# Brief\n',
      'src/app.ts': 'export {};\n',
      '.specify/templates/plan-template.md': '# Plan\n',
    });
    const manifest = buildManifest(root, PIN);
    expect(Object.keys(manifest.files).sort()).toEqual(
      [
        ...Object.keys(INSTALLED),
        '.claude/hooks/pre.sh',
        '.specify/templates/plan-template.md',
      ].sort(),
    );
    expect(manifest.files['.mcp.json']).toBe(sha256(MCP_JSON));
    expect(manifest).toMatchObject({ release: 'v1.0.0', commit: PIN.sha });
  });

  it('AC-003: isProtected covers hashed paths, .factory/config, the brief and any .gitattributes, .gitmodules, CLAUDE.md or CLAUDE.local.md', () => {
    for (const path of [
      '.claude/agents/define.md',
      '.claude/hooks/x',
      '.mcp.json',
      '.github/workflows/ci.yml',
      '.specify/memory/constitution.md',
      '.specify/templates/plan-template.md',
      '.specify/feature.json',
      '.factory/lockfile-policy',
      '.factory/config',
      '.factory/brief.md',
      'CLAUDE.md',
      'docs/deep/CLAUDE.md',
      'src/CLAUDE.local.md',
      'claude.md',
      'docs/Claude.Local.md',
      '.gitattributes',
      'src/deep/.gitattributes',
      'vendor/.gitmodules',
      './.claude/settings.json',
      // In any letter case, as a disk that ignores case opens them (T077).
      '.MCP.json',
      '.Claude/settings.local.json',
      '.GitHub/Workflows/ci.yml',
      '.Specify/memory/constitution.md',
      '.Factory/Lockfile-Policy',
      '.factory/CONFIG',
    ])
      expect(isProtected(path), path).toBe(true);
    for (const path of ['.MCP.json', '.Claude/settings.local.json', '.SPECIFY/x'])
      expect(isHashed(path) && coversHashed(path), path).toBe(true);
    expect(coversHashed('.CLAUDE')).toBe(true);
    expect(isProtected('.Factory/Brief.md', { define: true })).toBe(false);
    for (const path of [
      'src/app.ts',
      '.factory/events/2026-10.jsonl',
      '.github/CODEOWNERS',
      'docs/CLAUDE.md.bak',
      '.factory/define/answers.md',
    ])
      expect(isProtected(path), path).toBe(false);
    // Only a Define pull request may change the brief (T173).
    expect(isProtected('.factory/brief.md', { define: true })).toBe(false);
    expect(isProtected('CLAUDE.md', { define: true })).toBe(true);
  });

  it('T173: the import scan errs toward flagging', () => {
    // A code span becomes a space, so the `@` after it still starts an import.
    expect(importsOutside('CLAUDE.md', 'x`code`@AGENTS.md\n')).toEqual(['AGENTS.md']);
    // An `@` after any character no path holds, and none inside a word such as an address.
    expect(importsOutside('CLAUDE.md', 'Read **@AGENTS.md** and mail me@example.com\n')).toEqual([
      'AGENTS.md',
    ]);
    expect(importsOutside('CLAUDE.md', 'Read _@AGENTS.md_ and a1@b.md\n')).toEqual(['AGENTS.md']);
    // The raw token counts too: `.factory/config.` is not the protected `.factory/config`.
    expect(importsOutside('CLAUDE.md', 'See @.factory/config.\n')).toEqual(['.factory/config.']);
    expect(importsOutside('CLAUDE.md', 'See @.factory/config, then\n')).toEqual([
      '.factory/config,',
    ]);
    expect(importsOutside('CLAUDE.md', 'See @.factory/config then\n')).toEqual([]);
    // Define may change the brief, so importing it is flagged.
    expect(importsOutside('docs/CLAUDE.md', '@../.factory/brief.md\n')).toEqual([
      '../.factory/brief.md',
    ]);
  });

  it('T173: the CLAUDE.md display fails on any git failure, never showing nothing', () => {
    expect(() => claudeMdShown(tempDir('factory-not-a-repo-'), gitEnv)).toThrow(/git ls-tree/);
  });

  it('T173: the CLAUDE.md display refuses a gitlink by that name, in any letter case', () => {
    const repo = makeRepo({ files: { 'src/a.ts': 'a\n' } });
    const sha = repo.revParse('HEAD');
    repo.git(['update-index', '--add', '--cacheinfo', `160000,${sha},docs/Claude.md`]);
    repo.git(['commit', '-q', '--no-gpg-sign', '-m', 'gitlink']);
    expect(() => claudeMdShown(repo.path, gitEnv)).toThrow(/docs\/Claude\.md is a submodule/);
  });

  it('T173: the CLAUDE.md display quotes every line, so none passes for the factory’s own, and counts no flag as none', () => {
    const forged =
      'Imports outside the protected set, which can change what every session reads: none';
    const repo = makeRepo({ files: { 'CLAUDE.md': `@.claude/notes.md\n${forged}\n` } });
    expect(claudeMdShown(repo.path, gitEnv).split('\n')).toEqual([
      'Every agent session loads each CLAUDE.md and CLAUDE.local.md. On main now:',
      '',
      'CLAUDE.md: stays on main as it is',
      '│ @.claude/notes.md',
      `│ ${forged}`,
      '',
      forged,
    ]);
    expect(claudeMdShown(makeRepo({ files: { 'a.md': 'x\n' } }).path, gitEnv)).toBe('');
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

/** A `specify` on PATH that records any run: the factory never runs it (T171). */
const SPECIFY = `#!/bin/sh
touch "$(dirname "$0")/specify-ran"
exit 1
`;

/**
 * The Owner's laptop: a factory clone whose release v1.0.0 of `sources` is tagged with `tagKey`
 * (`null`: an unsigned annotated tag), the Owner key and key list in `~/.factory`, a `specify`
 * that must not run, and the public factory repo on the fake GitHub serving the same tag.
 * Sessions start through fake launchers, or with `realLaunchers` through the default ones.
 */
function laptop({
  tagKey,
  sources = SOURCES,
  realLaunchers = false,
}: { tagKey?: TestKeys | null; sources?: Record<string, string>; realLaunchers?: boolean } = {}) {
  const factory = makeRepo({
    files: {
      ...Object.fromEntries(Object.entries(sources).map(([p, text]) => [`factory/${p}`, text])),
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
      ...(realLaunchers ? {} : { launchers }),
      unreadAlerts: () => Promise.resolve([]),
      ask: (question) => {
        asked.push({ question, printed: out.join(''), ghCalls: calls() });
        return Promise.resolve(answer);
      },
    });
    return { code, stdout: out.join(''), stderr: err.join(''), asked };
  };
  const ranSpecify = () => existsSync(join(bin, 'specify-ran'));
  return { cli, cwd, sha, launchers, ranSpecify };
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
    expect(made.ranSpecify()).toBe(false);
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

  it('AC-003: starts Station 0 (Define) on claude/define with the chosen launcher, in the new clone', () => {
    expect(made.launchers.cloud.launches).toEqual([]);
    expect(made.launchers.local.asked).toEqual([work]);
    expect(made.launchers.local.launches).toMatchObject([
      { project: work, role: 'define', station: 0, branch: 'claude/define' },
    ]);
  });

  it('AC-003: Define gets the release’s Station 0 prompt, with the pitch in its fence (T159)', () => {
    const prompt = made.launchers.local.launches[0]?.prompt ?? '';
    expect(prompt).toMatch(/^Station 0 \(Define\) for owner\/sample\. Work only on the branch/);
    expect(prompt).toContain(
      '`.factory/define/pitch.md`:\n\n```text\nA tiny bookmark list I use from my laptop browser.\n```',
    );
    expect(prompt).toContain('5 to 10 seed issues listed in `.factory/define/backlog.md`');
  });

  it('AC-064: re-running Define on a project made by factory new keeps its pitch (T159)', async () => {
    const again = await made.cli(['adopt', 'owner/sample']);
    expect(again.stderr).toBe('');
    expect(made.launchers.local.launches).toHaveLength(2);
    expect(made.launchers.local.launches[1]?.prompt).toContain('```text\nA tiny bookmark list');
  });
});

describe(
  'factory new: Define through the release and the default launchers (T159)',
  { timeout: 120_000 },
  () => {
    it('a release without the Station 0 prompt installs the project but starts no Define', async () => {
      const sources = { ...SOURCES };
      delete sources['prompts/station-0-define.md'];
      const { cli, cwd, launchers } = laptop({ sources });
      const r = await cli(['new', 'A pitch', '--name', 'sample']);
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/Created owner\/sample/);
      expect(r.stderr).toMatch(
        /Define was not started: the release pinned at [0-9a-f]{12} has no factory\/prompts\/station-0-define\.md/,
      );
      expect(r.stderr).toContain('factory adopt owner/sample');
      expect(existsSync(join(cwd, 'sample', '.factory', 'config'))).toBe(true);
      expect(launchers.local.launches).toEqual([]);
    });

    it('without launchers from the caller, the local launcher checks the new clone and waits for the guards', async () => {
      const { cli } = laptop({ realLaunchers: true });
      const r = await cli(['new', 'A pitch', '--name', 'sample']);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(
        /Define was not started: the local launcher is not available: release v1\.0\.0 installs no factory hooks/,
      );
    });
  },
);

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

describe(
  'factory new and factory adopt: the repository checked as .factory/config will',
  { timeout: 60_000 },
  () => {
    /** The laptop with the fake GitHub's signed-in user set to `user`. */
    function as(user: string) {
      const at = laptop();
      const path = process.env.FAKE_GH_STATE ?? '';
      writeFileSync(path, JSON.stringify({ ...readState(), user }));
      return at;
    }

    it.each([
      ['-owner/x', '-owner', 'x'],
      ['owner/..', 'owner', '..'],
      ['owner/-x', 'owner', '-x'],
    ])('factory new refuses %s, creating nothing', async (_repo, user, name) => {
      const { cli, cwd, launchers } = as(user);
      // `--name=`, so the argument parser does not read a leading `-` as an option.
      const r = await cli(['new', 'A pitch', `--name=${name}`]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/is not owner\/name|invalid repository name/);
      expect(touchesRepo(calls())).toBe(false);
      expect(readdirSync(cwd)).toEqual([]);
      expect(launchers.local.launches).toEqual([]);
    });

    it.each(['-owner/x', 'owner/..'])(
      'factory adopt refuses %s before asking GitHub',
      async (repo) => {
        const { cli, cwd, launchers } = laptop();
        const r = await cli(['adopt', '--', repo]);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toMatch(/expected owner\/repo/);
        expect(calls()).toEqual([]);
        expect(readdirSync(cwd)).toEqual([]);
        expect(launchers.local.launches).toEqual([]);
      },
    );
  },
);

describe('factory adopt (AC-007, AC-064)', { timeout: 120_000 }, () => {
  const APP = 'export const app = 1;\n';
  const ATTRIBUTES = '*.ts text eol=lf\n';
  /**
   * Imports: product files, a protected one, the home folder, outside the repository, an absolute
   * path, the brief, and ones only quoted as code; a control and a bidi character.
   */
  const CLAUDE_MD = [
    '# Legacy',
    '',
    'See @docs/style.md and @.specify/memory/constitution.md, and @~/notes.md.',
    'Mail me@example.com. Run `@src/skip.md` as written, or **@AGENTS.md**.',
    'Also @../../x, @/etc/hosts, @.factory/config. and @.factory/brief.md',
    '```sh',
    '@inside/fence.md',
    '```',
    'Red \u001b[31m text \u202e end',
    '',
  ].join('\n');
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
    writeTree(legacy, {
      ...{ 'src/app.ts': APP, '.gitattributes': ATTRIBUTES },
      ...{ 'CLAUDE.md': CLAUDE_MD, 'docs/Claude.local.md': '@../.claude/settings.json\n' },
      '.claude/CLAUDE.md': '@README.md\n',
    });
    mkdirSync(join(legacy, 'pkg'));
    symlinkSync('../AGENTS.md', join(legacy, 'pkg', 'CLAUDE.md'));
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

  it('T173: shows every CLAUDE.md before asking, quoted, with each import outside the protected set flagged', () => {
    const printed = first.asked[0]?.printed ?? '';
    const quoted = (text: string) => text.replace(/\n$/, '').replace(/^/gm, '│ ');
    expect(printed).toContain(
      quoted(CLAUDE_MD.replace('\u001b', '\\u{1b}').replace('\u202e', '\\u{202e}')),
    );
    expect(printed).not.toContain('\u001b');
    expect(printed).toContain(".claude/CLAUDE.md: install replaces it with the release's files");
    expect(printed).toContain('CLAUDE.md: stays on main as it is');
    expect(printed).toContain(
      'docs/Claude.local.md: stays on main as it is\n│ @../.claude/settings.json',
    );
    expect(printed).toContain('pkg/CLAUDE.md: stays on main as it is\n  a symlink to ../AGENTS.md');
    expect(printed).toContain(
      [
        'Imports outside the protected set, which can change what every session reads: 8',
        '- CLAUDE.md imports docs/style.md',
        '- CLAUDE.md imports ~/notes.md',
        '- CLAUDE.md imports AGENTS.md',
        '- CLAUDE.md imports ../../x',
        '- CLAUDE.md imports /etc/hosts',
        '- CLAUDE.md imports .factory/config.',
        '- CLAUDE.md imports .factory/brief.md',
        '- pkg/CLAUDE.md links to ../AGENTS.md',
      ].join('\n'),
    );
    expect(printed.indexOf('CLAUDE.md')).toBeLessThan(
      printed.indexOf('provider-managed cloud VMs'),
    );
  });

  it('AC-007: keeps the existing code and .gitattributes, and hands the code to Define', () => {
    expect(read(work, 'src/app.ts')).toBe(APP);
    expect(read(work, '.gitattributes')).toBe(ATTRIBUTES);
    for (const [rel, text] of Object.entries(INSTALLED)) expect(read(work, rel)).toBe(text);
    expect(read(work, '.specify/templates/checklist-template.md')).toBe('# Checklist\n');
    expect(made.ranSpecify()).toBe(false);
    expect(made.launchers.local.launches).toEqual([]);
    expect(made.launchers.cloud.launches).toMatchObject([
      { project: work, role: 'define', station: 0, branch: 'claude/define' },
    ]);
    expect(made.launchers.cloud.launches[0]?.prompt).toMatch(
      /^Station 0 \(Define\) for owner\/legacy\.[\s\S]*This repository was adopted: the existing code/,
    );
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
