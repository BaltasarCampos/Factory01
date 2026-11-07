// `factory deploy` (T053), slices 23a to 23c-1b; its health check and deploy-healthy record are
// in deploy-command-health.test.ts, `factory merge`'s cases in merge-command.test.ts, and the
// setup they share in tests/helpers/merge-deploy.ts and tests/helpers/deploy.ts.
import { createServer } from 'node:http';
import {
  chmodSync,
  existsSync,
  readFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { nonceLedgerPath } from '../../src/approvals/nonces.js';
import { extractFromComment, parse } from '../../src/approvals/record.js';
import { ownerKeyPath } from '../../src/approvals/sign.js';
import { matchFields, verifySignature } from '../../src/approvals/verify.js';
import { unitName, unitRelease } from '../../src/deploy/service.js';
import { readState } from '../helpers/fake-gh.js';
import { runGit, signedReleaseTag, type TestRepo } from '../helpers/git-repo.js';
import { tempDir, writeKeyFiles } from '../helpers/keys.js';
import {
  AT,
  ITEM,
  ITEM_BRANCH,
  LOG_BRANCH,
  REPO,
  itemRecord,
  labeledAt,
  makeTestKeys,
  onMain,
  other,
  owner,
  posted,
  pushRunAt,
} from '../helpers/merge-deploy.js';
import {
  APP,
  BACKUP,
  TIMER,
  NOTE,
  NOTE_PATH,
  deployLines,
  deployLog,
  deployable,
  inboxComments,
  mergeItem,
  nonceOf,
  onLog,
  portsFrom,
  recordOf,
  takePort,
  product,
  releaseIn,
  releasesOf,
  systemd,
} from '../helpers/deploy.js';

vi.setConfig({ testTimeout: 60_000 });
beforeAll(makeTestKeys);
portsFrom(23_000);

// Slices 23a and 23b-2a: `factory deploy` exports main's verified commit into a new release folder,
// builds it in two bubblewrap runs, the install with network and the build without, then switches
// the app's systemd user unit to it, here with a fake `systemctl --user` that serves the unit's
// port when its release holds a file `serves`.
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

/** The item's records as the fake GitHub holds them. */
const itemComments = () =>
  readState().repos[REPO]?.issues.find((i) => i.number === ITEM)?.comments ?? [];

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
      const port = takePort();
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
