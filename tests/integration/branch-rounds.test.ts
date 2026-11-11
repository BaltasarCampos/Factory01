import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { dispatcherMessage } from '../../src/dispatcher/branch.js';
import { dispatchOnce, ownerAnswers, shellWord } from '../../src/dispatcher/dispatch.js';
import { gatherEvidence } from '../../src/dispatcher/evidence.js';
import {
  failureFile,
  readFailureRecord,
  recordIssued,
  writeFailureRecord,
} from '../../src/dispatcher/failures.js';
import { pendingManifest, writeStationManifest } from '../../src/dispatcher/manifest.js';
import { groupRecord } from '../../src/dispatcher/launcher/local.js';
import { LaunchRefused, SessionFailed } from '../../src/dispatcher/launcher/types.js';
import { ReleaseIncomplete } from '../../src/dispatcher/prompts.js';
import { configOnMain } from '../../src/model/config.js';
import { parseAlert } from '../../src/notify/inbox.js';
import { type Tier } from '../../src/model/types.js';
import { type LaunchRecord } from '../helpers/fake-launcher.js';
import { makeRepo, type Files } from '../helpers/git-repo.js';
import { makeOtherKeys, tempDir, writeKeyFiles, type TestKeys } from '../helpers/keys.js';
import {
  REPO,
  ISSUE,
  BRANCH,
  FEATURE,
  PIN,
  BEFORE,
  HASH,
  owner,
  approvalBody,
  setup,
  editState,
  SPEC,
  CREATED,
  SPECIFIED,
} from '../helpers/branch.js';

describe('Verify results from the required check runs (T168)', { timeout: 60_000 }, () => {
  const LIST = readFileSync(
    new URL('../../factory/profiles/typescript/ci/required-checks.json', import.meta.url),
    'utf8',
  );
  /** A factory clone whose one commit, the pin, holds `list` as the release's required checks. */
  const factoryClone = (list: string | null = LIST) => {
    const path = 'factory/profiles/typescript/ci/required-checks.json';
    const repo = makeRepo({
      files: list === null ? { 'README.md': 'f\n' } : { [path]: list },
    });
    return { path: repo.path, sha: repo.revParse('HEAD') };
  };
  const CI_YML = '.github/workflows/ci.yml';
  const SECURITY_YML = '.github/workflows/security.yml';
  type Ran = [workflow: string, job: string, conclusion: string | null];
  const CI_JOBS = ['build-test', 'coverage', 'ac-map', 'red-green', 'weakened', 'size'];
  /** Every job the release requires of an item that changes no events.jsonl, green. */
  const ITEM_JOBS: Ran[] = [
    ...CI_JOBS.map((job): Ran => [CI_YML, job, 'success']),
    ...['semgrep', 'gitleaks', 'npm-audit', 'licences'].map((job): Ran => [
      SECURITY_YML,
      job,
      'success',
    ]),
  ];
  const withJob = (job: string, conclusion: string | null): Ran[] =>
    ITEM_JOBS.map(([w, j, c]) => [w, j, j === job ? conclusion : c]);
  let nextRun = 700;
  /** GitHub Actions at `sha`: one pull_request run per workflow file, with the jobs that ran. */
  const actionsAt = (sha: string, ran: Ran[]) => {
    editState((repo) => {
      const runs = [...new Set(ran.map(([w]) => w))].map((path) => ({
        ...{ id: nextRun++, path, head_sha: sha, head_branch: BRANCH, event: 'pull_request' },
        ...{ status: 'completed', conclusion: 'success' },
      }));
      repo.api[`repos/${REPO}/actions/runs?head_sha=${sha}&event=pull_request&per_page=100`] = {
        total_count: runs.length,
        workflow_runs: runs,
      };
      for (const run of runs) {
        const jobs = ran
          .filter(([w]) => w === run.path)
          .map(([, name, conclusion], i) => ({
            ...{ id: run.id * 100 + i, name, run_attempt: 1, conclusion },
            status: conclusion === null ? 'in_progress' : 'completed',
          }));
        repo.api[`repos/${REPO}/actions/runs/${String(run.id)}/jobs?filter=all&per_page=100`] = {
          total_count: jobs.length,
          jobs,
        };
      }
    });
  };
  const openPr = () => {
    editState((repo) => {
      repo.prs.push({
        ...{ number: 9, title: '#2', body: '', author: 'owner', headRefName: BRANCH },
        ...{ baseRefName: 'main', headRefOid: '', isDraft: true, state: 'OPEN' },
        ...{ comments: [], createdAt: BEFORE },
      });
    });
  };
  const tipOf = (t: ReturnType<typeof setup>) => t.project.git(['rev-parse', `origin/${BRANCH}`]);
  const SECURITY = '## Scans\n\n- semgrep: none\n\n## Findings\n\n- none\n';
  /** Evidence at Verify, read the way the dispatcher reads it, with `factory` as the release. */
  const verifying = (branch: Record<string, string>, factory = factoryClone()) => {
    const t = setup({ branch: { ...SPECIFIED, ...branch } });
    openPr();
    return { t, factory, tip: tipOf(t) };
  };
  const gatherAt = (
    t: ReturnType<typeof setup>,
    state: 'verifying' | 'building',
    factory?: { path: string; sha: string },
  ) => {
    const issue = { number: ISSUE, title: 'Add login', author: 'owner', body: '', labels: [] };
    const onMain = configOnMain(t.project.path);
    const pin = { ...onMain.factory_release, ...(factory ? { sha: factory.sha } : {}) };
    const ctx = { ...t.evidence, ...(factory ? { factory: factory.path } : {}) };
    return gatherEvidence(ctx)(
      { issue, state, branch: BRANCH, tier: 2 },
      { ...onMain, factory_release: pin },
      { lastVerified: undefined, merges: [], commits: [] },
      writeKeyFiles([owner]),
    );
  };

  it('AC-013: at Verify, reads the pinned release’s item jobs at the head of the item’s PR, from workflow runs', async () => {
    const { t, factory, tip } = verifying({ 'src/login.ts': 'export {};\n' });
    actionsAt(tip, withJob('coverage', 'failure'));

    const e = await gatherAt(t, 'verifying', factory);

    const state = (job: string) => (job === 'coverage' ? 'failure' : 'success');
    expect(e.requiredChecks).toEqual({
      head: tip,
      jobs: ITEM_JOBS.map(([, job]) => ({ job, state: state(job) })),
    });
  });

  it('AC-013: a PR changing events.jsonl also needs append-only, and a job that never ran is missing', async () => {
    const { t, factory, tip } = verifying({ [`${FEATURE}/events.jsonl`]: '{}\n' });
    actionsAt(tip, withJob('gitleaks', null));

    const jobs = (await gatherAt(t, 'verifying', factory)).requiredChecks?.jobs ?? [];

    expect(jobs).toContainEqual({ job: 'gitleaks', state: 'pending' });
    expect(jobs).toContainEqual({ job: 'append-only', state: 'missing' });
  });

  it('AC-013: reads no checks before Verify, or without a PR on the head', async () => {
    const { t, factory, tip } = verifying({});
    actionsAt(tip, ITEM_JOBS);
    expect((await gatherAt(t, 'building', factory)).requiredChecks).toBeUndefined();

    const noPr = setup({ branch: CREATED });
    expect((await gatherAt(noPr, 'verifying', factory)).requiredChecks).toBeUndefined();
  });

  it('AC-013: a pin without required-checks.json, or no factory clone, holds the item with the reason', async () => {
    const { t, factory, tip } = verifying({}, factoryClone(null));
    actionsAt(tip, ITEM_JOBS);

    expect((await gatherAt(t, 'verifying', factory)).requiredChecks).toEqual({
      head: tip,
      jobs: [],
      unreadable:
        'the release pinned on main has no required-checks.json; the item waits in Verify',
    });
    expect((await gatherAt(t, 'verifying')).requiredChecks?.unreadable).toMatch(/no factory clone/);
  });

  it('AC-013: reads reports/security.md: complete with no finding open, or not', async () => {
    const report = `${FEATURE}/reports/security.md`;
    const clean = verifying({ [report]: SECURITY });
    expect((await gatherAt(clean.t, 'verifying')).securityReport).toBe(true);
    const open = SECURITY.replace(
      '- none',
      '- [ ] blocking: eval at src/a.ts:1: input reaches eval',
    );
    const failing = verifying({ [report]: open });
    expect((await gatherAt(failing.t, 'verifying')).securityReport).toBe(false);
    const none = verifying({});
    expect(await gatherAt(none.t, 'verifying')).not.toHaveProperty('securityReport');
  });

  it('AC-013: a red required job keeps the item in Verify, with one info alert per red head', async () => {
    const factory = factoryClone();
    const t = setup({
      pin: `v1.0.0@${factory.sha}`,
      states: ['state:verifying'],
      branch: {
        ...SPECIFIED,
        [`${FEATURE}/reports/verify.md`]: '| Check | Result |\n|---|---|\n| Review | pass |\n',
        [`${FEATURE}/reports/security.md`]: SECURITY,
      },
    });
    t.ctx.gatherEvidence = gatherEvidence({ ...t.evidence, factory: factory.path });
    openPr();
    const red = (tip: string) =>
      `#2: required checks red at ${tip.slice(0, 12)}: semgrep (failure)`;
    const alerts = () =>
      t.inbox().flatMap((c) => {
        const a = parseAlert({ ...c, id: String(c.id) });
        return a?.kind === 'checks-red' ? [`${a.urgency} ${a.text}`] : [];
      });
    const first = tipOf(t);
    actionsAt(first, withJob('semgrep', 'failure'));

    expect((await dispatchOnce(t.ctx)).moves).toEqual([]);
    expect((await dispatchOnce(t.ctx)).moves).toEqual([]);
    expect(alerts()).toEqual([`info ${red(first)}`]);

    t.project.checkout(BRANCH);
    t.project.commit({ 'src/login.ts': 'export {};\n' }, 'fix');
    t.project.push(BRANCH);
    t.project.checkout('main');
    const second = tipOf(t);
    actionsAt(second, withJob('semgrep', 'failure'));
    await dispatchOnce(t.ctx);

    expect(alerts()).toEqual([`info ${red(first)}`, `info ${red(second)}`]);
    expect(t.labels()).toContain('state:verifying');
  });

  it('T168: required checks that cannot be read hold Verify with one info alert per head, naming why', async () => {
    const factory = factoryClone(null);
    const t = setup({
      pin: `v1.0.0@${factory.sha}`,
      states: ['state:verifying'],
      branch: {
        ...SPECIFIED,
        [`${FEATURE}/reports/verify.md`]: '| Check | Result |\n|---|---|\n| Review | pass |\n',
        [`${FEATURE}/reports/security.md`]: SECURITY,
      },
    });
    t.ctx.gatherEvidence = gatherEvidence({ ...t.evidence, factory: factory.path });
    openPr();
    await dispatchOnce(t.ctx);
    await dispatchOnce(t.ctx);

    const unreadable = t.inbox().flatMap((c) => {
      const a = parseAlert({ ...c, id: String(c.id) });
      return a?.kind === 'checks-unreadable' ? [`${a.urgency} ${a.text}`] : [];
    });
    expect(unreadable).toEqual([
      `info #2: required checks at ${tipOf(t).slice(0, 12)} cannot be read: the release pinned on main has no required-checks.json; the item waits in Verify`,
    ]);
    expect(t.labels()).toContain('state:verifying');
  });

  /** An item at Verify with a failing review, at `tier`, its required checks green at its head. */
  const failingReview = (tier: Tier) => {
    const factory = factoryClone();
    // Tier 2 needs the Owner's approval of this spec.md to start a session.
    const spec = createHash('sha1').update(`blob ${String(Buffer.byteLength(SPEC))}\0${SPEC}`);
    const more = { gate: 'spec-approved' as const, spec_sha: spec.digest('hex') };
    const t = setup({
      ...{ tier, pin: `v1.0.0@${factory.sha}` },
      states: ['state:verifying', ...(tier > 1 ? ['owner:spec-approved'] : [])],
      comments: tier > 1 ? [{ body: approvalBody(tier, more), createdAt: BEFORE }] : [],
      branch: {
        ...SPECIFIED,
        [`${FEATURE}/reports/verify.md`]: '| Check | Result |\n|---|---|\n| Review | fail |\n',
      },
    });
    t.ctx.gatherEvidence = gatherEvidence({ ...t.evidence, factory: factory.path });
    openPr();
    const green = () => {
      actionsAt(tipOf(t), ITEM_JOBS);
    };
    green();
    const alerts = () =>
      t.inbox().flatMap((c) => {
        const a = parseAlert({ ...c, id: String(c.id) });
        return a?.kind === 'verify-failed' ? [`${a.urgency} ${a.text}`] : [];
      });
    const failed = (tip: string) =>
      `info #2: reports/verify.md does not pass at ${tip.slice(0, 12)}; Verify's sessions for its tier have ended and nothing sends it back to Build yet: close this item and file it again`;
    return { t, green, alerts, failed };
  };

  it('T181: a failing tier 1 review alerts once, and a second pass at the same head nothing new', async () => {
    const { t, alerts, failed } = failingReview(1);

    await dispatchOnce(t.ctx);
    await dispatchOnce(t.ctx);

    expect(alerts()).toEqual([failed(tipOf(t))]);
    expect(t.local.launches).toEqual([]);
    expect(t.labels()).toContain('state:verifying');
  });

  it('T181: a failing tier 2 review alerts only once Security has ended', async () => {
    const { t, green, alerts, failed } = failingReview(2);

    await dispatchOnce(t.ctx);
    expect(t.local.launches).toMatchObject([{ station: 5, role: 'security' }]);
    green();
    await dispatchOnce(t.ctx);
    expect(alerts()).toEqual([]);

    // Security's session follows its manifest, which went straight to origin.
    t.project.git(['branch', '-f', BRANCH, `origin/${BRANCH}`]);
    t.project.checkout(BRANCH);
    t.project.commit({ [`${FEATURE}/reports/security.md`]: SECURITY }, 'Security report');
    t.project.push(BRANCH);
    t.project.checkout('main');
    green();
    await dispatchOnce(t.ctx);
    await dispatchOnce(t.ctx);

    expect(alerts()).toEqual([failed(tipOf(t))]);
    expect(t.local.launches).toHaveLength(1);
  });

  describe("Build's round on CI's build-test (T174)", () => {
    const TASKS = [
      '### Tests',
      '- [ ] T001 Login tests (AC-001) · Files: tests/login.test.ts',
      '### Implementation',
      '- [ ] T002 Login form · Files: src/login.ts',
    ].join('\n');
    const TASKS_MD = `${FEATURE}/tasks.md`;
    const BUILD_MANIFEST = 'Dispatcher: station 4 (builder) manifest';
    /** An item in Build at tier 1 whose first task the dispatcher has issued. */
    const issued = async (config?: string, failure?: Error) => {
      const factory = factoryClone();
      const t = setup({
        ...{ tier: 1, pin: `v1.0.0@${factory.sha}`, states: ['state:building'] },
        ...(config === undefined ? {} : { config }),
        branch: { ...SPECIFIED, [TASKS_MD]: TASKS },
      });
      t.ctx.gatherEvidence = gatherEvidence({ ...t.evidence, factory: factory.path });
      if (failure !== undefined) t.local.failure = failure;
      openPr();
      await dispatchOnce(t.ctx);
      return Object.assign(t, { factory });
    };
    /** `files` committed and pushed on origin's branch head, as the session does; the new head. */
    const work = (t: ReturnType<typeof setup>, files: Files = { 'tests/login.test.ts': 't\n' }) => {
      t.project.git(['checkout', '-q', '-B', BRANCH, `origin/${BRANCH}`]);
      const trailers = { 'Factory-Role': 'builder', 'Factory-Item': '2-add-login' };
      t.project.commit(files, 'Login tests', { trailers });
      t.project.push(BRANCH);
      t.project.checkout('main');
      return tipOf(t);
    };
    const buildTest = (sha: string, conclusion: string | null) => {
      actionsAt(sha, [[CI_YML, 'build-test', conclusion]]);
    };
    const alerts = (t: ReturnType<typeof setup>, kind: string) =>
      t.inbox().flatMap((c) => {
        const a = parseAlert({ ...c, id: String(c.id) });
        return a?.kind === kind ? [`${a.urgency} ${a.text}`] : [];
      });
    const task = (t: ReturnType<typeof setup>) =>
      (JSON.parse(t.show(`${FEATURE}/.station.json`)) as { task?: string }).task;

    it('T174: holds Build while build-test runs, then ticks the task in its own commit and issues the next', async () => {
      const t = await issued();
      const head = work(t);
      buildTest(head, null);
      await dispatchOnce(t.ctx);
      expect(t.local.launches).toHaveLength(1);

      buildTest(head, 'success');
      await dispatchOnce(t.ctx);

      expect(t.show(TASKS_MD)).toBe(TASKS.replace('- [ ] T001', '- [X] T001'));
      const tick = t.project.git(['log', '-1', '--format=%P%n%B', `origin/${BRANCH}~1`]);
      expect(tick).toBe(`${head}\n${dispatcherMessage('tick T001', '2-add-login').trim()}`);
      expect(t.local.launches.map((l) => l.station)).toEqual([4, 4]);
      expect(task(t)).toBe('T002');
      // Each session's own settings allow edits of its task's files alone (T061).
      expect(t.local.launches.map(({ feature, files }) => ({ feature, files }))).toEqual([
        { feature: FEATURE, files: ['tests/login.test.ts'] },
        { feature: FEATURE, files: ['src/login.ts'] },
      ]);
    });

    it('T174: a red head gives the Builder the same task again with the failure, in its prompt and its manifest, at most retry_limit times', async () => {
      const t = await issued('retry_limit: 1\n');
      const first = work(t);
      buildTest(first, 'failure');
      await dispatchOnce(t.ctx);
      expect(task(t)).toBe('T001');
      const line = `Your last attempt at T001 left CI red at ${first.slice(0, 12)}: build-test (failure).`;
      expect(t.local.launches[1]?.prompt).toContain(line);
      // The manifest keeps the line, so a relaunch on it gets the same prompt (T061); the first
      // manifest, with no failure, has none.
      const station = `${FEATURE}/.station.json`;
      expect(JSON.parse(t.show(station))).toMatchObject({ task: 'T001', failure: line });
      const issuedFirst = t.project.git(['show', `${first}~1:${station}`]);
      expect(JSON.parse(issuedFirst)).not.toHaveProperty('failure');

      const second = work(t, { 'tests/login.test.ts': 't2\n' });
      buildTest(second, 'failure');
      await dispatchOnce(t.ctx);
      await dispatchOnce(t.ctx);

      expect(t.local.launches).toHaveLength(2);
      expect(t.show(TASKS_MD)).toBe(TASKS);
      expect(alerts(t, 'build-failed')).toEqual([
        `info #2: T001 left CI red at ${second.slice(0, 12)}: build-test (failure), after 2 Build sessions with retry_limit 1; nothing sends it on before T096: close this item and file it again`,
      ]);
    });

    /** Runs `pass` with a `git` first on PATH that fails, exit 128, on any `arg` it is given. */
    const failingGit = async (arg: string, pass: () => Promise<unknown>) => {
      const dir = tempDir();
      const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      const script = `#!/bin/sh\nfor a in "$@"; do [ "$a" = "${arg}" ] && { echo 'fatal: injected' >&2; exit 128; }; done\nexec ${real} "$@"\n`;
      writeFileSync(join(dir, 'git'), script, { mode: 0o755 });
      const path = process.env.PATH;
      process.env.PATH = [dir, path ?? ''].join(delimiter);
      try {
        await pass();
      } finally {
        process.env.PATH = path;
      }
    };

    it('T060: a git failure reading a station file stops the pass, never reads as missing', async () => {
      const t = await issued();
      work(t);

      await failingGit('ls-tree', async () => {
        await expect(dispatchOnce(t.ctx)).rejects.toThrow(/git ls-tree .* failed: fatal: injected/);
      });
      expect(t.local.launches).toHaveLength(1);
    });

    it('T174: a build-test that cannot be read holds Build with one info alert per head, naming why', async () => {
      const t = await issued();
      t.ctx.gatherEvidence = gatherEvidence(t.evidence);
      const head = work(t);
      await dispatchOnce(t.ctx);
      await dispatchOnce(t.ctx);

      expect(t.local.launches).toHaveLength(1);
      expect(alerts(t, 'checks-unreadable')).toEqual([
        `info #2: build-test at ${head.slice(0, 12)} cannot be read: no factory clone to read required-checks.json from; Build waits until it can`,
      ]);
    });

    it('T174: an ancestry check that fails with a git error stops the pass and alerts nothing', async () => {
      const t = await issued();
      buildTest(work(t), 'success');

      await failingGit('--is-ancestor', async () => {
        await expect(dispatchOnce(t.ctx)).rejects.toThrow(/git merge-base failed: fatal: injected/);
      });
      expect(alerts(t, 'tampering')).toEqual([]);
      expect(t.show(TASKS_MD)).toBe(TASKS);
    });

    it("T181: a git failure reading the dispatcher's Test record stops the pass, never reads as not ended", async () => {
      const t = setup({ tier: 2, states: ['state:verifying'], branch: CREATED });
      // Injected on the record's own read, whatever it holds.
      await failingGit(`refs/factory/test/${BRANCH}^{commit}`, async () => {
        await expect(dispatchOnce(t.ctx)).rejects.toThrow(/git rev-parse failed: fatal: injected/);
      });
      expect(t.local.launches).toEqual([]);
    });

    it('T174: with no record in the clone the open task is issued again, then holds at the cap', async () => {
      const t = await issued('retry_limit: 1\n');
      const forget = () => t.project.git(['update-ref', '-d', `refs/factory/build/${BRANCH}`]);
      forget();
      work(t);
      await dispatchOnce(t.ctx);
      expect(t.local.launches).toHaveLength(2);

      forget();
      const head = work(t, { 'tests/login.test.ts': 't2\n' });
      await dispatchOnce(t.ctx);
      await dispatchOnce(t.ctx);

      expect(t.local.launches).toHaveLength(2);
      expect(alerts(t, 'build-failed')).toEqual([
        `info #2: T001 is still open at ${head.slice(0, 12)} after 2 Build sessions with retry_limit 1; nothing sends it on before T096: close this item and file it again`,
      ]);
    });

    it("T061: a session's forged Build manifest whose .station.json does not parse, is 2 MiB, or sits at a path with pathspec magic issues the task again and never throws", async () => {
      // A manifest the dispatcher could have written but for its size, past spawnSync's 1 MiB.
      const big = { item: ISSUE, station: 4, role: 'builder', branch: BRANCH, task: 'T001' };
      const huge = `${JSON.stringify({ ...big, pad: 'x'.repeat(2 * 1024 * 1024) })}\n`;
      // Each sorts first in diff-tree's list: `:(glob)` made ls-tree exit 128, and `:/` made it
      // size the item's real manifest while git show read the forged one.
      const forgeries = [
        { [`${FEATURE}/.station.json`]: '{' },
        { [`${FEATURE}/.station.json`]: huge },
        { [`:/${FEATURE}/.station.json`]: huge },
        { ':(glob)x/.station.json': '{}\n' },
      ];
      for (const files of forgeries) {
        const t = await issued();
        t.project.git(['checkout', '-q', '-B', BRANCH, `origin/${BRANCH}`]);
        t.project.commit(files, BUILD_MANIFEST);
        t.project.push(BRANCH);
        t.project.checkout('main');
        const tip = tipOf(t);
        buildTest(tip, 'success');
        const at = { projectDir: t.project.path, now: () => new Date() };
        expect(pendingManifest(at, tip, FEATURE)).toBe('unreadable');
        await dispatchOnce(t.ctx);

        expect(t.show(TASKS_MD)).toBe(TASKS);
        expect(t.local.launches).toHaveLength(2);
        expect(task(t)).toBe('T001');
        expect(t.project.git(['rev-parse', `origin/${BRANCH}~1`])).toBe(tip);
      }
    });

    it('T061: a spent Build manifest whose record in the clone was deleted waits, pushing nothing', async () => {
      const t = await issued();
      const manifest = tipOf(t);
      t.project.git(['update-ref', '-d', `refs/factory/build/${BRANCH}`]);
      await dispatchOnce(t.ctx);
      await dispatchOnce(t.ctx);

      expect(t.local.launches).toHaveLength(1);
      expect(tipOf(t)).toBe(manifest);
      expect(t.inbox()).toEqual([]);
    });

    it('T061: with a stale record in the clone and the failure record deleted, CI green at a later Build manifest ticks nothing', async () => {
      const t = await issued();
      const first = tipOf(t);
      buildTest(work(t), 'failure');
      // A later pass: its manifest's issued_at differs, so it changes .station.json.
      t.ctx.now = () => new Date('2026-10-01T12:00:00Z');
      await dispatchOnce(t.ctx);
      const second = tipOf(t);
      expect(t.local.launches).toHaveLength(2);
      // As when update-ref failed after the second manifest's push.
      t.project.git(['update-ref', `refs/factory/build/${BRANCH}`, first]);
      rmSync(failureFile(t.home, REPO, ISSUE, 4));
      buildTest(second, 'success');
      await dispatchOnce(t.ctx);

      expect(t.show(TASKS_MD)).toBe(TASKS);
      expect(t.local.launches).toHaveLength(3);
      expect(t.project.git(['rev-parse', `origin/${BRANCH}~1`])).toBe(second);
    });

    it('T061: with its failure record deleted, CI green at the manifest itself ticks nothing, and the task is issued again', async () => {
      const t = await issued();
      const manifest = tipOf(t);
      buildTest(manifest, 'success');
      rmSync(failureFile(t.home, REPO, ISSUE, 4));
      await dispatchOnce(t.ctx);

      expect(t.show(TASKS_MD)).toBe(TASKS);
      expect(t.local.launches).toHaveLength(2);
      expect(task(t)).toBe('T001');
      expect(t.project.git(['rev-parse', `origin/${BRANCH}~1`])).toBe(manifest);
    });

    it("T061: holds Build, naming how to restore the clone's record, when the failure record names a tip the evidence reads as new", async () => {
      const t = await issued();
      const manifest = tipOf(t);
      t.project.git(['update-ref', '-d', `refs/factory/build/${BRANCH}`]);
      // Only the dispatcher's records name the tip as its own manifest.
      const elsewhere = { home: tempDir(), factory: () => HASH };
      t.ctx.gatherEvidence = gatherEvidence({
        ...{ projectDir: t.project.path, failures: elsewhere, factory: t.factory.path },
      });
      const result = await dispatchOnce(t.ctx);
      await dispatchOnce(t.ctx);

      expect(t.local.launches).toHaveLength(1);
      expect(tipOf(t)).toBe(manifest);
      const file = failureFile(t.home, REPO, ISSUE, 4);
      const reason = `no manifest is pushed on ${manifest.slice(0, 12)}: the failure record ${file} names it as the dispatcher's own manifest, which a new one never stacks on; delete it, by its path, to start its count again; the dispatcher's own record of that Build manifest is missing too: restore it with git -C '${t.project.path}' update-ref refs/factory/build/${BRANCH} ${manifest}`;
      expect(result.held).toEqual([{ issue: ISSUE, reason }]);
      expect(alerts(t, 'manifest-held')).toEqual([`info #2 holds: ${reason}`]);
      // The clone's path is one shell word, whatever it holds.
      expect(shellWord("/a b/it's")).toBe(`'/a b/it'\\''s'`);
    });

    /** An item in Build with every task ticked and a current conflict report from Integrate. */
    /**
     * An item in Build with every task ticked and a current conflict report listing `listed`;
     * main then adds each of `conflicts` differently from the branch, signed by the Owner.
     */
    const conflicted = (
      config?: string,
      { listed = ['src/login.ts'], conflicts = ['src/login.ts'] } = {},
    ) => {
      const t = setup({
        ...{ tier: 1, states: ['state:building'] },
        ...(config === undefined ? {} : { config }),
        branch: {
          ...{ ...SPECIFIED, [TASKS_MD]: TASKS.replace(/- \[ \]/g, '- [X]') },
          ...Object.fromEntries(conflicts.map((path) => [path, 'branch\n'])),
          [`${FEATURE}/reports/integrate.md`]: `## Conflicts\n\n${listed.map((p) => `- \`${p}\`\n`).join('')}`,
        },
      });
      if (conflicts.length > 0) {
        t.project.commit(
          Object.fromEntries(conflicts.map((path) => [path, 'main\n'])),
          'Main moved',
          { signWith: owner },
        );
        t.project.push('main');
      }
      return t;
    };

    it('T174: the conflict session takes the files git finds conflicted, not the ones the report lists', async () => {
      const listed = ['src/login.ts', 'src/extra.ts'];
      const t = conflicted(undefined, { listed, conflicts: ['src/login.ts', 'src/other.ts'] });
      await dispatchOnce(t.ctx);

      const manifest = JSON.parse(t.show(`${FEATURE}/.station.json`)) as { files?: string[] };
      // An extra file the report lists is left out; a conflict main gained later is in.
      expect(manifest.files).toEqual(['src/login.ts', 'src/other.ts']);
    });

    it('T174: a conflict report git cannot confirm issues no session, with one alert', async () => {
      const t = conflicted(undefined, { conflicts: [] });
      await dispatchOnce(t.ctx);
      await dispatchOnce(t.ctx);

      expect(t.local.launches).toEqual([]);
      expect(alerts(t, 'build-failed')).toEqual([
        `info #2: reports/integrate.md lists conflicts with main, but git merges origin/main into ${BRANCH} at ${tipOf(t).slice(0, 12)} with none, so no conflict session is issued; nothing sends it on before T096: close this item and file it again`,
      ]);
    });

    it('T174: a git failure reading tasks.md stops the manifest, never reads as a conflict session', async () => {
      const t = conflicted();
      const at = { projectDir: t.project.path, now: () => new Date() };
      await failingGit('ls-tree', () => {
        const write = () =>
          writeStationManifest(
            at,
            { issue: ISSUE, branch: BRANCH },
            { station: 4, role: 'builder' },
          );
        expect(write).toThrow(/git ls-tree .* failed: fatal: injected/);
        return Promise.resolve();
      });
    });

    it('T174: a merge-tree that fails stops the pass and issues nothing', async () => {
      const t = conflicted();
      await failingGit('merge-tree', async () => {
        await expect(dispatchOnce(t.ctx)).rejects.toThrow(/git merge-tree failed: fatal: injected/);
      });
      expect(t.local.launches).toEqual([]);
    });

    it('T174: a current conflict report starts a Build session with no task and the listed files, which the Builder’s merge ends', async () => {
      const t = conflicted();
      await dispatchOnce(t.ctx);

      const manifest = JSON.parse(t.show(`${FEATURE}/.station.json`)) as Record<string, unknown>;
      expect(manifest).toMatchObject({ station: 4, role: 'builder', files: ['src/login.ts'] });
      expect(manifest).not.toHaveProperty('task');
      expect(t.local.launches[0]?.prompt).toContain('Integrate sent this item back');
      expect(manifest.failure).toMatch(/^Integrate sent this item back/);
      // Any commit but a clean merge of main makes the report stale.
      work(t, { 'src/login.ts': 'resolved\n' });
      await dispatchOnce(t.ctx);
      expect(t.local.launches).toHaveLength(1);
    });

    it('T174: past retry_limit conflict sessions, Build holds with one alert', async () => {
      const t = conflicted('retry_limit: 1\n');
      t.project.git(['checkout', '-q', '-B', BRANCH, `origin/${BRANCH}`]);
      for (const at of ['09', '10'])
        t.project.commit(
          {
            [`${FEATURE}/.station.json`]: `{"item":2,"station":4,"files":[],"issued_at":"${at}"}\n`,
          },
          dispatcherMessage('station 4 (builder) manifest', '2-add-login'),
        );
      t.project.commit({ [`${FEATURE}/reports/verify.md`]: 'x\n' }, 'Review');
      t.project.push(BRANCH);
      t.project.checkout('main');
      await dispatchOnce(t.ctx);
      await dispatchOnce(t.ctx);

      expect(t.local.launches).toEqual([]);
      expect(alerts(t, 'build-failed')).toEqual([
        `info #2: the conflict with main is still open at ${tipOf(t).slice(0, 12)} after 2 Build sessions with retry_limit 1; nothing sends it on before T096: close this item and file it again`,
      ]);
    });

    it('T174: a rewritten branch with a forged manifest commit is never ticked, and the Owner gets one urgent alert', async () => {
      const t = await issued();
      const pushed = tipOf(t);
      t.project.git(['checkout', '-q', '-B', BRANCH, `origin/${BRANCH}~1`]);
      const forged = { item: 2, station: 4, role: 'builder', branch: BRANCH, task: 'T001' };
      t.project.commit(
        { [`${FEATURE}/.station.json`]: `${JSON.stringify({ ...forged, files: [] })}\n` },
        dispatcherMessage('station 4 (builder) manifest', '2-add-login'),
      );
      t.project.push(BRANCH, { force: true });
      const head = work(t);
      buildTest(head, 'success');
      await dispatchOnce(t.ctx);
      await dispatchOnce(t.ctx);

      expect(t.show(TASKS_MD)).toBe(TASKS);
      expect(t.local.launches).toHaveLength(1);
      expect(alerts(t, 'tampering')).toEqual([
        `urgent #2: the Build manifest the dispatcher pushed, ${pushed.slice(0, 12)}, is not in the history of ${BRANCH} at ${head.slice(0, 12)}: the branch was rewritten, so nothing more is ticked or issued for this item; close it and file it again`,
      ]);
    });

    /** What a launch was given, its callbacks and session id aside. */
    const given = (l?: LaunchRecord) =>
      l === undefined
        ? undefined
        : { ...l, starting: undefined, heartbeat: undefined, sessionId: undefined };
    /** The failure record of the item at `station`. */
    const recordAt = (t: ReturnType<typeof setup>, station: 2 | 4 | 5) =>
      readFailureRecord(failureFile(t.home, REPO, ISSUE, station));
    const passes = async (t: ReturnType<typeof setup>, n: number) => {
      const results = [];
      for (let i = 0; i < n; i++) results.push(await dispatchOnce(t.ctx));
      return results;
    };

    it('T061: a failing session is started again on its spent manifest retry_limit times, then holds with one alert and no branch commit, at Specify and at Build', async () => {
      const failure = new SessionFailed('claude exited 1: \u0007', false);
      // One at a time: each setup seeds the fake GitHub anew.
      const cases = [
        [
          async () => {
            const spec = setup({ config: 'retry_limit: 2\n' });
            spec.local.failure = failure;
            await dispatchOnce(spec.ctx); // the manifest and its first attempt, as issued() does
            return spec;
          },
          2,
        ],
        [() => issued('retry_limit: 2\n', failure), 4],
      ] as const;
      for (const [make, station] of cases) {
        const t = await make();
        const manifest = tipOf(t);
        const results = await passes(t, 3);

        // retry_limit + 1 attempts, each on the one manifest commit, and nothing pushed after it.
        expect(t.local.launches).toHaveLength(3);
        expect(tipOf(t)).toBe(manifest);
        expect(recordAt(t, station)).toMatchObject({ head: manifest, count: 3, outcome: 'failed' });
        const file = failureFile(t.home, REPO, ISSUE, station);
        const reason = `3 sessions started at ${manifest.slice(0, 12)} with retry_limit 2, so no more start there; the last failure: claude exited 1: \\u{7}; the failure record is ${file}; delete it to start its count again, or push a new head or install a new factory release`;
        expect(results.at(-1)?.held).toEqual([{ issue: ISSUE, reason }]);
        expect(alerts(t, 'retry-limit')).toEqual([`info #2 holds: ${reason}`]);
      }
    });

    it('T061: a full context holds at once with one alert; an unknown one is an ordinary failure, started again with the same prompt', async () => {
      const t = setup();
      const full = new SessionFailed('claude exited 1', false);
      full.contextFull = true;
      t.local.failure = full;
      await passes(t, 3);
      expect(t.local.launches).toHaveLength(1);
      const manifest = tipOf(t);
      const file = failureFile(t.home, REPO, ISSUE, 2);
      expect(alerts(t, 'context-full')).toEqual([
        `info #2 holds: the session at ${manifest.slice(0, 12)} filled its context, so the item is too big for one session: split it; the last failure: claude exited 1; the failure record is ${file}; delete it to start its count again`,
      ]);

      const u = setup();
      u.local.failure = new SessionFailed('claude exited 1', false);
      await passes(u, 2);
      expect(recordAt(u, 2)).toMatchObject({ count: 2, context_full: null });
      const [first, again] = u.local.launches;
      // Nothing else changed, so the relaunch's prompt and settings are the first attempt's.
      expect(given(again)).toEqual(given(first));
      expect(again?.sessionId).toBe('fake-local-2');
      expect(u.project.git(['log', '-1', '--format=%s', `origin/${BRANCH}`])).toBe(
        'Dispatcher: station 2 (spec) manifest',
      );
    });

    it('T061: a refusal is not counted and is tried again each pass with one alert; once fixed the session starts on the same manifest, and so does a stale head check', async () => {
      const t = setup();
      t.local.refusal = new LaunchRefused('no local session started: claude is not on PATH');
      await passes(t, 3);
      const manifest = tipOf(t);
      expect(t.local.asked).toHaveLength(3);
      expect(recordAt(t, 2)).toEqual({ head: manifest, factory: HASH, count: 0 });
      expect(alerts(t, 'launcher-unavailable')).toHaveLength(1);
      delete t.local.refusal;
      await dispatchOnce(t.ctx);
      expect(t.local.launches).toHaveLength(1);
      expect(tipOf(t)).toBe(manifest);

      // The head check saw a push the branch then lost: refused uncounted, at a tip that reads
      // as unmoved, and the session starts there on the next pass.
      const u = setup();
      u.local.beforeStart = () => {
        u.project.git(['checkout', '-q', '-B', BRANCH, `origin/${BRANCH}`]);
        u.project.commit({ [`${FEATURE}/notes.md`]: 'late\n' }, 'a late push');
        u.project.push(BRANCH);
        u.project.checkout('main');
      };
      expect((await dispatchOnce(u.ctx)).held?.[0]?.reason).toMatch(
        /the branch moved after its manifest/,
      );
      delete u.local.beforeStart;
      const issuedAt = u.project.git(['rev-parse', `origin/${BRANCH}~1`]);
      u.project.git(['push', '-q', '-f', 'origin', `${issuedAt}:refs/heads/${BRANCH}`]);
      await dispatchOnce(u.ctx);
      expect(u.local.launches).toHaveLength(1);
      expect(recordAt(u, 2)).toMatchObject({ head: issuedAt, count: 1, outcome: 'ended' });
    });

    it('T061: a release-incomplete hold names the pin, so a re-pin to another release with the same broken template alerts again', async () => {
      const t = setup();
      const path = 'factory/prompts/station-2-specify.md';
      const broken = `${path}: no value for {{nobody}}; pin a release on main with a correct ${path}`;
      t.ctx.stationPrompt = () => {
        throw new ReleaseIncomplete(broken);
      };
      await passes(t, 2);
      const head = tipOf(t).slice(0, 12);
      const config = t.project.git(['show', 'origin/main:.factory/config']);
      const repinned = config.replace(PIN, `v1.0.1@${'b'.repeat(40)}`);
      t.project.commit({ '.factory/config': repinned }, 'Re-pin', { signWith: owner });
      t.project.push('main');
      await passes(t, 2);

      // The relaunches stay on the one spent manifest, uncounted: only the pin changed.
      expect(t.local.launches).toEqual([]);
      expect(tipOf(t).slice(0, 12)).toBe(head);
      expect(alerts(t, 'release-incomplete')).toEqual(
        ['v1.0.0 (aaaaaaaaaaaa)', 'v1.0.1 (bbbbbbbbbbbb)'].map(
          (pin) => `info #2 holds: release ${pin}: ${broken}; ${BRANCH} is at ${head}`,
        ),
      );
    });

    it('T061: an attempt with no outcome is started again once no group of it lives, read by sessionRunning alone', async () => {
      const t = setup();
      t.local.failure = new Error('the factory was stopped');
      await expect(dispatchOnce(t.ctx)).rejects.toThrow('the factory was stopped');
      expect(recordAt(t, 2)).not.toHaveProperty('outcome');
      delete t.local.failure;
      const dir = join(t.home, '.factory', 'sessions', 'fake-local-1');
      mkdirSync(dir, { recursive: true });
      const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
      await once(child, 'spawn');
      const pgid = child.pid;
      if (pgid === undefined) throw new Error('sleep has no pid');
      try {
        writeFileSync(join(dir, 'group.json'), JSON.stringify(groupRecord(pgid)));
        await dispatchOnce(t.ctx);
        expect(t.local.launches).toHaveLength(1);
      } finally {
        process.kill(-pgid, 'SIGKILL');
      }
      await vi.waitFor(() => {
        expect(() => process.kill(-pgid, 0)).toThrow();
      });
      await dispatchOnce(t.ctx);
      expect(t.local.launches).toHaveLength(2);
      expect(recordAt(t, 2)).toMatchObject({ count: 2, session: 'fake-local-2', outcome: 'ended' });
    });

    it('T061: after a red CI round, a session failing on the re-issued manifest is started again with its failure line, and CI green at that manifest ticks nothing', async () => {
      const t = await issued();
      const head = work(t);
      buildTest(head, 'failure');
      t.local.failure = new SessionFailed('claude exited 1', false);
      await dispatchOnce(t.ctx); // the re-issued manifest, whose session fails
      const manifest = tipOf(t);
      buildTest(manifest, 'success');
      await dispatchOnce(t.ctx);

      const line = `Your last attempt at T001 left CI red at ${head.slice(0, 12)}: build-test (failure).`;
      const [, reissued, relaunched] = t.local.launches;
      expect(reissued?.prompt).toContain(line);
      expect(given(relaunched)).toEqual(given(reissued));
      expect(tipOf(t)).toBe(manifest);
      expect(t.show(TASKS_MD)).toBe(TASKS);
      expect(recordAt(t, 4)).toMatchObject({ head: manifest, count: 2 });
    });

    it("T061: a Verify relaunch keeps its manifest's role, whatever the evidence would name", async () => {
      const t = setup({ tier: 1, states: ['state:verifying'], branch: { ...SPECIFIED } });
      const at = { projectDir: t.project.path, now: () => new Date() };
      const records = t.ctx.failures;
      const where = { repo: REPO, item: ISSUE, station: 5 } as const;
      // The dispatcher's own Security manifest, failed, where the evidence at tier 1 names the
      // Reviewer.
      writeStationManifest(
        at,
        { issue: ISSUE, branch: BRANCH },
        { station: 5, role: 'security' },
        'origin/main',
        (sha, parent) => {
          recordIssued(records, where, sha, parent);
        },
      );
      const manifest = tipOf(t);
      const file = failureFile(t.home, REPO, ISSUE, 5);
      writeFailureRecord(file, {
        head: manifest,
        factory: HASH,
        count: 1,
        outcome: 'failed',
        last: 'x',
      });

      await dispatchOnce(t.ctx);

      expect(t.local.launches).toMatchObject([{ station: 5, role: 'security' }]);
      expect(tipOf(t)).toBe(manifest);
    });

    it("T061: the dispatcher's own manifest that cannot be read holds its item with one urgent alert and the pass goes on; a git failure reading it stops the pass", async () => {
      const t = setup({ branch: CREATED, states: ['state:triaged'], other: true });
      const tip = tipOf(t);
      // A record naming a commit that is no manifest: the factory's bug or local corruption.
      const file = failureFile(t.home, REPO, ISSUE, 2);
      writeFailureRecord(file, { head: tip, factory: HASH, count: 1, outcome: 'failed' });
      await passes(t, 2);

      expect(tipOf(t)).toBe(tip);
      expect(t.local.launches.map((l) => l.item)).toEqual([3]);
      expect(alerts(t, 'manifest-unreadable')).toEqual([
        `urgent #2 holds: the dispatcher's own manifest at ${tip}, which the failure record ${file} names, cannot be read as one, so no session starts on it: reinstall the pinned release, or delete ${file}`,
      ]);
      // Reading the dispatcher's own failed manifest, git fails: the pass stops.
      const u = setup();
      u.local.failure = new SessionFailed('claude exited 1', false);
      await dispatchOnce(u.ctx);
      await failingGit('--literal-pathspecs', async () => {
        await expect(dispatchOnce(u.ctx)).rejects.toThrow('git ls-tree failed: fatal: injected');
      });
      expect(u.local.launches).toHaveLength(1);
    });
  });
});

describe('the question loop (T180, AC-033)', { timeout: 60_000 }, () => {
  const ASKING = SPEC.replace(
    '## Problem',
    [
      '## Clarifications',
      '- Q1: Which sign-in should visitors use?',
      '  - Options: A) Email and password B) A magic link C) Both',
      '',
      '## Problem',
    ].join('\n'),
  );
  /** The Owner's answers, committed alone and signed (T182), unless `as` says otherwise. */
  const answer = (
    t: ReturnType<typeof setup>,
    text: string,
    as: { signWith?: TestKeys | null; also?: Files } = {},
  ) => {
    t.project.checkout(BRANCH);
    const signWith = as.signWith === undefined ? owner : as.signWith;
    const files = { [`${FEATURE}/answers.md`]: text, ...as.also };
    const sha = t.project.commit(files, 'Owner answers', signWith === null ? {} : { signWith });
    t.project.push(BRANCH);
    t.project.checkout('main');
    return sha;
  };
  const asking = (spec = ASKING) =>
    setup({ states: ['state:triaged'], branch: { ...CREATED, [`${FEATURE}/spec.md`]: spec } });
  const applied = (rest: string) => ASKING.replace('visitors use?', `visitors use? → A: ${rest}`);

  it('AC-033: an open question in spec.md blocks the item and the Owner is told what it is', async () => {
    const t = asking();

    const result = await dispatchOnce(t.ctx);

    expect(result.moves).toEqual([expect.objectContaining({ from: 'triaged', to: 'blocked' })]);
    expect(t.local.launches).toEqual([]);
    const [alert] = t.inbox().slice(-1);
    expect(alert?.body).toMatch(/urgency=info kind=question/);
    expect(alert?.body).toContain('- Q1 (spec.md): Which sign-in should visitors use?');
    expect(alert?.body).toContain(`${FEATURE}/answers.md on ${BRANCH}`);
  });

  it('AC-033: an answer that does not count keeps it blocked; one that counts returns it to the state it left', async () => {
    const t = asking();
    await dispatchOnce(t.ctx);

    answer(t, 'A1. Both, but only once the link expires\n');
    expect((await dispatchOnce(t.ctx)).moves).toEqual([]);
    expect(t.labels()).toContain('state:blocked');
    expect(t.inbox().at(-1)?.body).toContain('A1 does not count');

    answer(t, 'A1. B\n');
    const back = await dispatchOnce(t.ctx);
    expect(back.moves).toEqual([expect.objectContaining({ from: 'blocked', to: 'triaged' })]);
  });

  it('AC-033: back at Specify, the session runs clarify with the Owner’s answer (T180, slice 24c-2b)', async () => {
    const t = asking();
    await dispatchOnce(t.ctx);
    answer(t, 'A1. B\n');
    await dispatchOnce(t.ctx);
    await dispatchOnce(t.ctx);

    const [launch] = t.local.launches;
    expect(launch).toMatchObject({ station: 2, role: 'spec' });
    expect(launch?.prompt).toContain('## Step 1: speckit-clarify');
    expect(launch?.prompt).toContain('A1. B\n```');
  });

  it.each<[string, { signWith?: TestKeys | null; also?: Files }]>([
    ['unsigned', { signWith: null }],
    ['signed by a key the lists do not name', { signWith: makeOtherKeys() }],
    ['signed, but also changing another file', { also: { 'src/x.ts': 'x\n' } }],
  ])(
    'AC-033 (T182): answers in a commit %s count as none, and the Owner gets an urgent alert naming it',
    async (_name, as) => {
      const t = asking();
      await dispatchOnce(t.ctx);

      const sha = answer(t, 'A1. B\n', as);
      const result = await dispatchOnce(t.ctx);

      expect(result.moves).toEqual([]);
      expect(t.labels()).toContain('state:blocked');
      const alert = t.inbox().find((c) => /kind=tampering/.test(c.body));
      expect(alert?.body).toMatch(/urgency=urgent/);
      expect(alert?.body).toContain(sha.slice(0, 12));
      expect(alert?.body).toContain(
        'If the commit is yours, close this item and file it again; if it is not, look into it before anything else.',
      );
      expect(t.local.launches).toEqual([]);
    },
  );

  it('AC-033 (T182): an applied answer with no line from the Owner is open: the item blocks and the Owner is asked', async () => {
    const t = asking(applied('B'));

    const result = await dispatchOnce(t.ctx);

    expect(result.moves).toEqual([expect.objectContaining({ from: 'triaged', to: 'blocked' })]);
    expect(t.inbox().at(-1)?.body).toContain('- Q1 (spec.md): Which sign-in should visitors use?');
  });

  it.each([
    ['an applied answer that differs from the Owner’s', applied('A')],
    ['an Owner-action question answered differently', applied('C → Owner action: tier raise')],
  ])('AC-033 (T182): %s goes to clarify to apply', async (_name, spec) => {
    const t = asking(spec);
    answer(t, 'A1. B\n');

    await dispatchOnce(t.ctx);

    const [launch] = t.local.launches;
    expect(launch).toMatchObject({ station: 2, role: 'spec' });
    expect(launch?.prompt).toContain('## Step 1: speckit-clarify');
    expect(launch?.prompt).toContain('A1. B\n```');
  });

  it('T182: reading the branch for the prompt, only a missing file is absent; a git failure throws', () => {
    const t = asking();
    const at = { projectDir: t.project.path, now: () => new Date() };
    const keys = writeKeyFiles([owner]);
    t.project.git(['fetch', '-q', 'origin']);
    expect(ownerAnswers(at, BRANCH, 'plan.md', keys)).toEqual([]);
    expect(() => ownerAnswers(at, 'claude/9-not-pushed', 'spec.md', keys)).toThrow();
  });
});
