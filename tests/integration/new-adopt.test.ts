// Install steps behind `factory new` / `factory adopt` (slice 11a): guardrails rendered from the
// pinned release and checked against its manifest, labels, the pinned inbox, `.factory/config`
// and the `claude/define` branch. The commands themselves, consent and signed commits ship in
// slice 11b.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { EnvironmentError, RefusedError } from '../../src/cli/env.js';
import { createRepo } from '../../src/github/repo.js';
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
import { STATES, STATIONS, type GuardrailManifest } from '../../src/model/types.js';
import { readState, seedState } from '../helpers/fake-gh.js';
import { runGit } from '../helpers/git-repo.js';
import { tempDir } from '../helpers/keys.js';

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

  it('AC-003: creates every owner:, state:, tier: and pause: label, and none twice', async () => {
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
