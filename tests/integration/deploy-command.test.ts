// `factory deploy` (T053), slices 23a to 23d; `factory merge`'s cases are in
// merge-command.test.ts, and the setup both share in tests/helpers/merge-deploy.ts.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  chmodSync,
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
import { nonceLedgerPath } from '../../src/approvals/nonces.js';
import { extractFromComment, parse } from '../../src/approvals/record.js';
import { ownerKeyPath } from '../../src/approvals/sign.js';
import { matchFields, verifySignature } from '../../src/approvals/verify.js';
import { deploysLogPath } from '../../src/deploy/deploys-log.js';
import { stamp } from '../../src/deploy/release.js';
import { appFolder } from '../../src/deploy/sandbox.js';
import { unitName, unitRelease } from '../../src/deploy/service.js';
import { checkAppendOnly } from '../../src/ci/append-only.js';
import { mergeRules } from '../../src/merge/rules.js';
import { readState } from '../helpers/fake-gh.js';
import { runGit, signedReleaseTag, type Files, type TestRepo } from '../helpers/git-repo.js';
import { tempDir, writeKeyFiles } from '../helpers/keys.js';
import {
  AT,
  type CliOver,
  ITEM,
  ITEM_BRANCH,
  LOG_BRANCH,
  type MergeSetup,
  REPO,
  branchOnOrigin,
  input,
  itemRecord,
  labeledAt,
  makeTestKeys,
  mergeSetup,
  onMain,
  other,
  owner,
  posted,
  pushRunAt,
} from '../helpers/merge-deploy.js';

vi.setConfig({ testTimeout: 60_000 });
beforeAll(makeTestKeys);

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
