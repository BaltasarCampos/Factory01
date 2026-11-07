// `factory deploy`'s health check, its health summary and failure comment, and the signed
// deploy-healthy record (T053), slices 23c-2 and 23d, split from deploy-command.test.ts so CI runs
// the two in parallel; the setup they share is in tests/helpers/merge-deploy.ts and deploy.ts.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerKeyPath } from '../../src/approvals/sign.js';
import { stamp } from '../../src/deploy/release.js';
import { checkAppendOnly } from '../../src/ci/append-only.js';
import { mergeRules } from '../../src/merge/rules.js';
import { runGit, type TestRepo } from '../helpers/git-repo.js';
import { tempDir } from '../helpers/keys.js';
import {
  LOG_BRANCH,
  REPO,
  branchOnOrigin,
  input,
  makeTestKeys,
  onMain,
} from '../helpers/merge-deploy.js';
import {
  APP,
  TIMER,
  deployLines,
  deployable,
  inboxComments,
  mergeItem,
  nonceOf,
  onLog,
  portsFrom,
  recordOf,
  product,
  releaseIn,
  releasesOf,
  systemd,
} from '../helpers/deploy.js';

vi.setConfig({ testTimeout: 60_000 });
beforeAll(makeTestKeys);
portsFrom(14_000);

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
