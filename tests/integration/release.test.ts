// `factory release <tag>` and release-tag verification (T131, AC-083), with temp repos and real
// `ssh-keygen`: the Owner confirms, the manifest goes into the signed tag, and a tag that is
// unsigned, signed by an unknown or revoked key, or moved is refused.
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ownerKeyPath } from '../../src/approvals/sign.js';
import { runCli } from '../../src/cli/commands.js';
import { signedTag } from '../../src/git/sign.js';
import { parseManifest } from '../../src/install/manifest.js';
import { MCP_JSON } from '../../src/install/render.js';
import { ReleaseTagError, verifyReleaseTag } from '../../src/release/tag.js';
import { gitEnv, makeRepo, type TestRepo } from '../helpers/git-repo.js';
import { makeKeys, makeOtherKeys, tempDir, writeKeyFiles, type TestKeys } from '../helpers/keys.js';

const SOURCES = {
  'factory/settings/settings.json': '{ "permissions": {} }\n',
  'factory/constitution.md': '# Constitution\n',
  'factory/roles/define.md': '---\nname: define\n---\n',
  'src/cli/main.ts': 'export {};\n',
};

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

let ownerKey: TestKeys;
beforeAll(() => {
  ownerKey = makeKeys();
});
const owner = () => ownerKey;

/** The factory repo listing `signers`, and a laptop home holding the Owner key. */
function setup(signers: readonly TestKeys[] = [owner()]) {
  const repo = makeRepo({
    files: {
      ...SOURCES,
      allowed_signers: signers.map((k) => `${k.allowedSignersLine}\n`).join(''),
      revoked_keys: '',
    },
  });
  const home = tempDir('factory-home-');
  mkdirSync(join(home, '.factory', 'keys'), { recursive: true });
  copyFileSync(owner().privateKey, ownerKeyPath(home));
  chmodSync(ownerKeyPath(home), 0o600);

  const cli = async (argv: string[], answer = argv[1] ?? '', over: { remote?: boolean } = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const asked: string[] = [];
    const env: NodeJS.ProcessEnv = { ...gitEnv, HOME: home };
    if (over.remote) env.CLAUDE_CODE_REMOTE = 'true';
    const code = await runCli(argv, {
      stdout: { write: (s: string) => void out.push(s) },
      stderr: { write: (s: string) => void err.push(s) },
      env,
      stdinIsTTY: true,
      cwd: repo.path,
      unreadAlerts: () => Promise.resolve([]),
      ask: (question) => {
        asked.push(question);
        return Promise.resolve(answer);
      },
    });
    return { code, stdout: out.join(''), stderr: err.join(''), asked };
  };
  return { repo, cli };
}

const tagExists = (repo: TestRepo, tag: string) =>
  repo.git(['tag', '--list', tag]) !== '' ||
  repo.git(['ls-remote', '--tags', 'origin', tag]) !== '';

function verifyTagWith(repo: TestRepo, keys: readonly TestKeys[], tag: string): boolean {
  const { allowedSigners } = writeKeyFiles(keys);
  try {
    repo.git(['-c', `gpg.ssh.allowedSignersFile=${allowedSigners}`, 'verify-tag', tag]);
    return true;
  } catch {
    return false;
  }
}

describe('factory release (AC-083)', { timeout: 60_000 }, () => {
  it('AC-083: refuses off the laptop and creates nothing', async () => {
    const { repo, cli } = setup();
    const r = await cli(['release', 'v1.0.0'], 'v1.0.0', { remote: true });
    expect(r.code).toBe(1);
    expect(tagExists(repo, 'v1.0.0')).toBe(false);
  });

  it('AC-083: on confirm, signs a tag holding the manifest with its commit and pushes it', async () => {
    const { repo, cli } = setup();
    const head = repo.revParse('HEAD');
    const r = await cli(['release', 'v1.0.0']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`v1.0.0@${head}`);

    expect(repo.git(['ls-remote', '--tags', 'origin', 'v1.0.0'])).not.toBe('');
    expect(repo.git(['rev-parse', 'v1.0.0^{commit}'])).toBe(head);
    expect(verifyTagWith(repo, [owner()], 'v1.0.0')).toBe(true);
    expect(verifyTagWith(repo, [makeOtherKeys()], 'v1.0.0')).toBe(false);

    const message = repo.git(['cat-file', 'tag', 'v1.0.0']).split('\n\n').slice(1).join('\n\n');
    expect(parseManifest(message)).toEqual({
      release: 'v1.0.0',
      commit: head,
      files: {
        '.claude/agents/define.md': sha256(SOURCES['factory/roles/define.md']),
        '.claude/settings.json': sha256(SOURCES['factory/settings/settings.json']),
        '.mcp.json': sha256(MCP_JSON),
        '.specify/memory/constitution.md': sha256(SOURCES['factory/constitution.md']),
      },
    });
  });

  it('AC-083: shows the diff since the last signed tag and creates nothing unless confirmed', async () => {
    const { repo, cli } = setup();
    expect((await cli(['release', 'v1.0.0'])).code).toBe(0);
    repo.commit({ 'src/new-feature.ts': 'export const x = 1;\n' }, 'add a feature');
    repo.git(['tag', 'v1.0.5']); // unsigned: never the "last signed tag"
    repo.push();

    const r = await cli(['release', 'v1.1.0'], 'no');
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('since v1.0.0');
    expect(r.stdout).not.toContain('since v1.0.5');
    expect(r.stdout).toContain('src/new-feature.ts');
    expect(r.stdout).toContain('add a feature');
    expect(r.asked.join('')).toContain('v1.1.0');
    expect(r.stdout).toContain('nothing was created');
    expect(tagExists(repo, 'v1.1.0')).toBe(false);
  });

  it('AC-083: refuses a bad tag name, an existing tag, a dirty tree and a non-factory repo', async () => {
    const { repo, cli } = setup();
    expect((await cli(['release', '1.0'])).code).toBe(2);

    repo.git(['tag', 'v1.0.0']);
    expect((await cli(['release', 'v1.0.0'])).stderr).toContain('already exists');

    repo.commit({ 'src/a.ts': 'a\n' }, 'a');
    writeFileSync(join(repo.path, 'src/a.ts'), 'changed\n');
    const dirty = await cli(['release', 'v1.1.0']);
    expect(dirty.code).toBe(1);
    expect(dirty.stderr).toContain('uncommitted');

    const plain = makeRepo({ files: { 'README.md': 'x\n' } });
    const r = await runCli(['release', 'v1.0.0'], {
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      env: gitEnv,
      stdinIsTTY: true,
      cwd: plain.path,
      unreadAlerts: () => Promise.resolve([]),
      ask: () => Promise.resolve('v1.0.0'),
    });
    expect(r).toBe(1);
    expect(tagExists(plain, 'v1.0.0')).toBe(false);
  });

  it("AC-083: a tag signed with a key missing from the release's allowed_signers is deleted, not pushed", async () => {
    const { repo, cli } = setup([makeOtherKeys()]);
    const r = await cli(['release', 'v1.0.0']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('allowed_signers');
    expect(tagExists(repo, 'v1.0.0')).toBe(false);
  });
});

describe('verifyReleaseTag (AC-083)', { timeout: 60_000 }, () => {
  function tagged(signer: TestKeys, tag = 'v1.0.0') {
    const repo = makeRepo({ files: { 'a.txt': 'a\n' } });
    const sha = repo.revParse('HEAD');
    signedTag(
      { repo: repo.path, keyPath: signer.privateKey, stdinIsTTY: true, env: gitEnv },
      tag,
      sha,
      `release ${tag}`,
    );
    return { repo, sha };
  }

  it('AC-083: accepts a tag signed by a listed key, including an older one', () => {
    const old = makeOtherKeys();
    const { repo, sha } = tagged(old);
    expect(() => {
      verifyReleaseTag(repo.path, 'v1.0.0', sha, writeKeyFiles([old, owner()]));
    }).not.toThrow();
  });

  it('AC-083: refuses an unsigned tag, an unknown key, a revoked key and a moved tag', () => {
    const { repo, sha } = tagged(owner());
    repo.git(['tag', 'v2.0.0']);
    repo.git(['tag', '-a', '-m', 'unsigned', 'v3.0.0']);
    // The signed tag object of v1.0.0 placed under another name.
    repo.git(['update-ref', 'refs/tags/v4.0.0', repo.git(['rev-parse', 'refs/tags/v1.0.0'])]);
    const listed = writeKeyFiles([owner()]);
    const cases: [string, string, string, ReturnType<typeof writeKeyFiles>][] = [
      ['unknown key', 'v1.0.0', sha, writeKeyFiles([makeOtherKeys()])],
      ['revoked key', 'v1.0.0', sha, writeKeyFiles([owner()], [owner()])],
      ['moved', 'v1.0.0', 'f'.repeat(40), listed],
      ['missing', 'v9.9.9', sha, listed],
      ['lightweight', 'v2.0.0', sha, listed],
      ['annotated, unsigned', 'v3.0.0', sha, listed],
      ['renamed', 'v4.0.0', sha, listed],
    ];
    for (const [what, tag, target, keys] of cases) {
      expect(() => {
        verifyReleaseTag(repo.path, tag, target, keys);
      }, what).toThrow(ReleaseTagError);
    }
  });

  it('AC-083: a tag re-made on another commit by the Owner is refused for the old pin', () => {
    const { repo, sha } = tagged(owner());
    const next = repo.commit({ 'b.txt': 'b\n' }, 'b');
    repo.git(['tag', '-d', 'v1.0.0']);
    signedTag(
      { repo: repo.path, keyPath: owner().privateKey, stdinIsTTY: true, env: gitEnv },
      'v1.0.0',
      next,
      'moved',
    );
    expect(() => {
      verifyReleaseTag(repo.path, 'v1.0.0', sha, writeKeyFiles([owner()]));
    }).toThrow(/v1\.0\.0/);
  });
});
