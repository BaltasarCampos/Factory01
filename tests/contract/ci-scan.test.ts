// Contract tests for `factory ci scan` (T136, T141, FR-049): semgrep and gitleaks at the release's
// pinned versions with the release's configs, and the markers that would silence them. Nothing in
// the pull request silences either tool. Every case runs against the fakes in tests/helpers/bin,
// which do what the real tools do by default with each lever, and against the real pinned tools
// whenever they are on PATH; with CI=true the real runs are required, and fail without the tools.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/commands.js';
import { gitEnv, makeRepo, type Files, type TestRepo } from '../helpers/git-repo.js';

const FAKES = fileURLToPath(new URL('../helpers/bin', import.meta.url));
// The test setup puts the fakes first on every PATH; the real tools are looked up without them.
const PATH = (process.env.PATH ?? '')
  .split(delimiter)
  .filter((d) => d !== FAKES)
  .join(delimiter);
const onPath = (name: string) => PATH.split(delimiter).some((d) => existsSync(join(d, name)));
const TOOLSETS = [
  { tools: 'fake', PATH: `${FAKES}${delimiter}${PATH}` },
  ...(process.env.CI === 'true' || onPath('semgrep') || onPath('gitleaks')
    ? [{ tools: 'real', PATH }]
    : []),
];
const RUN = 300_000;

/** A GitHub token gitleaks recognises; new each time, so no allowlist knows it. */
const token = () =>
  `ghp_${randomBytes(48)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 36)}`;
const SECRET = (t: string) => `export const token = '${t}';\n`;
const EVAL = 'export const run = (code: string): unknown => eval(code);\n';

/** main with one clean source; the item branch checked out. */
function project(files: Files = {}) {
  const repo = makeRepo({ files: { 'src/calc.ts': 'export const one = 1;\n', ...files } });
  const base = repo.revParse('HEAD');
  repo.checkout('claude/42-calc', { create: true });
  return { repo, base };
}

/** Commits `files`, those a committed .gitignore lists too. */
function commitIgnored(repo: TestRepo, files: Files, message: string) {
  repo.commit(files, message);
  repo.git(['add', '-f', '--', ...Object.keys(files)]);
  repo.git(['commit', '-q', '--amend', '--no-edit', '--no-gpg-sign']);
  return repo.revParse('HEAD');
}

describe.each(TOOLSETS)('factory ci scan with the $tools tools', ({ PATH: path }) => {
  const env: NodeJS.ProcessEnv = { ...gitEnv, PATH: path };

  async function ci(repo: TestRepo, args: string[], extra: NodeJS.ProcessEnv = {}) {
    const out: string[] = [];
    const code = await runCli(['ci', 'scan', ...args], {
      stdout: { write: (s: string) => void out.push(s) },
      stderr: { write: (s: string) => void out.push(s) },
      env: { ...env, ...extra },
      stdinIsTTY: false,
      cwd: repo.path,
      unreadAlerts: () => Promise.reject(new Error('ci must not read the inbox')),
    });
    // The checks block the worker while their tools run; Vitest's own messages need a turn.
    await new Promise((resolve) => setImmediate(resolve));
    return { code, output: out.join('') };
  }

  it(
    'semgrep: a new match fails by its finding: target; a .semgrepignore, a nosemgrep comment or an emptied .semgrep.yml changes nothing',
    async () => {
      const { repo, base } = project();
      expect(await ci(repo, ['semgrep', base, 'HEAD'])).toMatchObject({ code: 0 });
      const head = repo.commit(
        {
          'src/run.ts': EVAL.replace(';\n', '; // nosemgrep\n'),
          'src/more.ts': EVAL,
          // Semgrep's own default list would skip tests/; the release's does not.
          'tests/util.ts': EVAL,
          '.semgrepignore': 'src/\n',
          'src/.semgrepignore': 'more.ts\n',
          '.semgrep.yml': 'rules: []\n',
          '.semgrep/rules.yml': 'rules: []\n',
        },
        'eval',
      );

      const r = await ci(repo, ['semgrep', base, head]);

      expect(r.code).toBe(1);
      expect(r.output).toContain(
        'finding:no-eval@src/run.ts:1: eval runs a string as code (1 at the head, 0 at the base); a finding:no-eval@src/run.ts:1 waiver covers it',
      );
      expect(r.output).toContain('finding:no-eval@src/more.ts:1:');
      expect(r.output).toContain('finding:no-eval@tests/util.ts:1:');
    },
    RUN,
  );

  it(
    'semgrep: a .gitignore listing a committed file hides nothing, nor do git ignore rules from outside the pull request',
    async () => {
      const { repo, base } = project();
      const head = commitIgnored(
        repo,
        {
          'src/evil.ts': EVAL,
          'src/other.ts': EVAL,
          'src/local.ts': EVAL,
          '.gitignore': 'src/evil.ts\n',
          'src/.gitignore': 'other.ts\n',
        },
        'ignored',
      );
      // Semgrep honours git's ignore rules when its tree sits inside a git work tree.
      const outer = makeRepo();
      writeFileSync(join(outer.path, '.git', 'info', 'exclude'), 'local.ts\n');
      mkdirSync(join(outer.path, 'tmp'));
      vi.stubEnv('TMPDIR', join(outer.path, 'tmp'));
      try {
        const r = await ci(repo, ['semgrep', base, head]);

        expect(r.code).toBe(1);
        for (const file of ['evil', 'other', 'local'])
          expect(r.output).toContain(`finding:no-eval@src/${file}.ts:1:`);
      } finally {
        vi.unstubAllEnvs();
      }
    },
    RUN,
  );

  it(
    'semgrep compares counts: a third copy of a match the base has twice is one new finding; moving a line is none',
    async () => {
      const twice = `${EVAL}${EVAL.replace('run', 'again')}`;
      const { repo, base } = project({ 'src/run.ts': twice });
      const moved = repo.commit({ 'src/run.ts': `export const x = 1;\n${twice}` }, 'move');
      expect(await ci(repo, ['semgrep', base, moved])).toMatchObject({ code: 0 });
      const head = repo.commit(
        { 'src/run.ts': `${twice}${EVAL.replace('run', 'third')}` },
        'third',
      );

      const r = await ci(repo, ['semgrep', base, head]);

      expect(r.code).toBe(1);
      expect(r.output.match(/^ {2}finding:/gm)).toHaveLength(1);
      expect(r.output).toContain(
        'finding:no-eval@src/run.ts:3: eval runs a string as code (3 at the head, 2 at the base)',
      );
    },
    RUN,
  );

  it(
    'gitleaks scans each commit: a secret added and removed in the next commit is found, under gitleaks:allow, .gitleaks.toml and .gitleaksignore alike',
    async () => {
      const t = token();
      const { repo, base } = project();
      const added = repo.commit(
        { 'src/config.ts': SECRET(t).replace(';\n', '; // gitleaks:allow\n') },
        'add',
      );
      const head = repo.commit(
        {
          'src/config.ts': 'export const token = process.env.TOKEN;\n',
          '.gitleaks.toml': "[extend]\nuseDefault = false\n[allowlist]\npaths = ['''.*''']\n",
          '.gitleaksignore': `${added}/src/config.ts:github-pat:1\n${added}:src/config.ts:github-pat:1\n`,
        },
        'remove',
      );

      const r = await ci(repo, ['gitleaks', base, head]);

      expect(r.code).toBe(1);
      expect(r.output).toContain(
        `finding:github-pat@src/config.ts:1: secret added in ${added}; a finding:github-pat@src/config.ts:1 waiver covers it`,
      );
      expect(r.output).toContain('2 commits scanned');
      expect(r.output).not.toContain(t);
    },
    RUN,
  );

  it(
    'gitleaks: path rules hold under the <sha>/ prefix, and neither a .gitignore nor a file name in the default allowlist hides anything',
    async () => {
      const { repo, base } = project();
      const head = commitIgnored(
        repo,
        {
          'certs/server.p12': 'not really a certificate\n',
          'certs/.gitignore': '*.p12\n',
          'src/gitleaks.toml.ts': `export const a = 1;\n${SECRET(token())}`,
          'src/node_modules/x.ts': SECRET(token()),
          'package-lock.json': `{ "token": "${token()}" }\n`,
        },
        'hide',
      );

      const r = await ci(repo, ['gitleaks', base, head]);

      expect(r.code).toBe(1);
      expect(r.output).toContain('finding:pkcs12-file@certs/server.p12:1:');
      expect(r.output).toContain('finding:github-pat@src/gitleaks.toml.ts:2:');
      expect(r.output).toContain('finding:github-pat@src/node_modules/x.ts:1:');
      expect(r.output).toContain('finding:github-pat@package-lock.json:1:');
    },
    RUN,
  );

  it(
    'gitleaks reads a merge as --cc does: merging main reports none of main’s lines, and a secret added in the merge itself is found',
    async () => {
      // Both sides change src/shared.ts, so its merged version differs from each parent.
      const shared = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n';
      const { repo, base } = project({ 'src/shared.ts': shared });
      repo.commit({ 'src/shared.ts': shared.replace('a = 1', 'a = 10') }, 'feature');
      repo.checkout('main');
      const onMain = repo.commit(
        { 'src/shared.ts': `${shared}${SECRET(token())}` },
        'main moves on',
      );
      repo.checkout('claude/42-calc');
      repo.git(['merge', '-q', '--no-ff', '--no-edit', 'main']);
      expect(await ci(repo, ['gitleaks', onMain, 'HEAD'])).toMatchObject({ code: 0 });
      expect((await ci(repo, ['gitleaks', base, 'HEAD'])).output).toContain('src/shared.ts:4');

      repo.git(['reset', '-q', '--hard', 'HEAD^']);
      repo.git(['merge', '-q', '--no-ff', '--no-commit', 'main']);
      const merged = repo.commit({ 'src/merge.ts': SECRET(token()) }, 'merge main');

      const r = await ci(repo, ['gitleaks', onMain, merged]);

      expect(r.code).toBe(1);
      expect(r.output).toContain(`finding:github-pat@src/merge.ts:1: secret added in ${merged}`);
      expect(r.output).not.toContain('src/shared.ts');
    },
    RUN,
  );

  it('a tool at another version than the release pins is refused, and so is a missing one', async () => {
    const { repo, base } = project();
    const other = { FAKE_SEMGREP_VERSION: '1.179.0', FAKE_GITLEAKS_VERSION: '8.30.0' };
    if (path.startsWith(FAKES)) {
      expect((await ci(repo, ['semgrep', base, 'HEAD'], other)).output).toMatch(
        /semgrep 1\.179\.0; the release pins 1\.180\.0/,
      );
      expect((await ci(repo, ['gitleaks', base, 'HEAD'], other)).output).toMatch(
        /gitleaks 8\.30\.0; the release pins 8\.30\.1/,
      );
    }
    // git stays on PATH; gitleaks is not there.
    const none = await ci(repo, ['gitleaks', base, 'HEAD'], { PATH: '/usr/bin:/bin' });
    expect(none).toMatchObject({ code: 1 });
    expect(none.output).toContain('gitleaks not found on PATH; the release pins gitleaks 8.30.1');
  });
});

describe('factory ci scan markers (T141)', () => {
  it('every added line holding a comment that would silence a tool is a finding; one already at the base is not', async () => {
    const { repo, base } = project({
      'src/old.ts': '// eslint-disable-next-line\nexport const o = 1;\n',
    });
    const lines = [
      "export const a = 'x'; // gitleaks:allow",
      'export const b = 1; // nosemgrep: no-eval',
      '/* eslint-disable */',
      '// @ts-ignore',
      '// @ts-nocheck',
      '// @ts-expect-error: on purpose',
    ];
    const head = repo.commit({ 'src/new.ts': `${lines.join('\n')}\n` }, 'markers');

    const out: string[] = [];
    const code = await runCli(['ci', 'scan', 'markers', base, head], {
      stdout: { write: (s: string) => void out.push(s) },
      stderr: { write: (s: string) => void out.push(s) },
      env: gitEnv,
      stdinIsTTY: false,
      cwd: repo.path,
      unreadAlerts: () => Promise.reject(new Error('ci must not read the inbox')),
    });

    expect(code).toBe(1);
    const markers = [
      'gitleaks:allow',
      'nosemgrep',
      'eslint-disable',
      '@ts-ignore',
      '@ts-nocheck',
      '@ts-expect-error',
    ];
    markers.forEach((marker, i) => {
      const target = `finding:${marker}@src/new.ts:${String(i + 1)}`;
      expect(out.join('')).toContain(`${target}: ${marker} added; a ${target} waiver covers it`);
    });
    expect(out.join('')).not.toContain('src/old.ts');
  });

  it('specs and Markdown are prose, not code: a marker named there is no finding', async () => {
    const { repo, base } = project();
    const mention = 'A `nosemgrep` comment is a finding.\n';
    const head = repo.commit(
      {
        'specs/001-x/spec.md': mention,
        'specs/001-x/notes.txt': mention,
        'docs/guide.md': mention,
        'README.markdown': mention,
        'src/doc.ts': `// ${mention}`,
      },
      'prose',
    );

    const out: string[] = [];
    const code = await runCli(['ci', 'scan', 'markers', base, head], {
      stdout: { write: (s: string) => void out.push(s) },
      stderr: { write: (s: string) => void out.push(s) },
      env: gitEnv,
      stdinIsTTY: false,
      cwd: repo.path,
      unreadAlerts: () => Promise.reject(new Error('ci must not read the inbox')),
    });

    expect(code).toBe(1);
    expect(out.join('').match(/^ {2}finding:/gm)).toEqual(['  finding:']);
    expect(out.join('')).toContain('finding:nosemgrep@src/doc.ts:1: nosemgrep added');
  });
});
