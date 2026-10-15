// `factory deploy` (contracts/cli.md, FR-007, T069; design v1.8, Owner decisions 2026-10-13):
// build and run main's verified commit on the laptop, only inside bubblewrap. Main's first-parent
// history is checked as `factory merge` checks it, in the Owner's checkout, which no sandbox ever
// sees (AC-073); the verified commit is exported without `.git` into a new release folder under
// the app folder; then `npm ci --ignore-scripts`, with the network, and the build, without, run
// in the deploy sandbox; then the app's systemd user unit is switched to the new release, and
// switched back if anything after the rewrite fails or the app does not answer and keep
// running (slice 23b-2a); the backup's service and timer are switched with it, old releases
// are removed, and the backup's last result is printed (slice 23b-2b). Before the export, after
// the local checks: the pause warning, and the chain of every item merged since the last deploy
// re-verified (slice 23c-1a); then CI on main's head, each item's rollback steps from the release
// notes, the approval summary, the Owner's yes, and the signed `deployed` record posted on the
// inbox issue, so nothing runs before it is signed and a refused deploy leaves no record (slice
// 23c-1b); a failure after signing, at the export, the build or the switch, says so on the inbox,
// unsigned. After the switch, the health check, and on failure the rollback steps and the
// Owner's choice to switch back; the health summary on `claude/factory-log` (slice 23c-2); then,
// when healthy, the Deploy health summary and the signed `deploy-healthy` record naming the
// `deployed` one. Only a deploy whose `deploy-healthy` record is posted removes old releases and
// is appended to `deploys.log`, with both records' comment ids (slice 23d). One deploy runs at a
// time.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { assertNewestKey } from '../approvals/newest-key.js';
import { newNonce, recordTimestamp } from '../approvals/record.js';
import { assertPassphraseTerminal } from '../approvals/sign.js';
import { factoryRoot } from '../ci/sandbox.js';
import type { CommandContext } from '../cli/commands.js';
import { ExitCode, RefusedError } from '../cli/env.js';
import { buildRelease } from '../deploy/build.js';
import { cleanReleases } from '../deploy/cleanup.js';
import { appendDeploy, deploysLogPath, lastDeploy } from '../deploy/deploys-log.js';
import { withDeployLock } from '../deploy/lock.js';
import { checkHealth, healthSummary, pushHealth } from '../deploy/health.js';
import { newRelease, stamp } from '../deploy/release.js';
import { releaseNotes, rollbackFor } from '../deploy/release-notes.js';
import { appFolder, deployRunner } from '../deploy/sandbox.js';
import {
  assertPortFree,
  assertUserManager,
  checkSettings,
  factoryProgram,
  lastBackup,
  switchService,
  unitName,
  userUnits,
  type Switched,
} from '../deploy/service.js';
import { ciOnMain, shippedSince, verifyShipped } from '../deploy/shipped.js';
import { safeGit } from '../git/diff.js';
import { checkedMain, fetchBranch, type MainContext } from '../merge/context.js';
import { postComment } from '../github/comments.js';
import { buildSummary, visible, type DeployView, type HealthView } from '../notify/summary.js';
import { confirmPause } from '../pause/confirm.js';
import { postSigned, viewIssue } from './approve.js';

const NOTHING = 'nothing was deployed';

type Project = Parameters<typeof viewIssue>[0];

/** The shipped items' `events.jsonl` at main, for Usage; telemetry, so a missing one is skipped. */
function eventsAt(at: MainContext, items: readonly { branch: string }[]): string | undefined {
  const texts = items.flatMap(({ branch }) => {
    const path = `specs/${branch.slice('claude/'.length)}/events.jsonl`;
    const shown = safeGit(at.cwd, ['show', `${at.main}:${path}`], at.env);
    return shown.status === 0 ? [shown.stdout.toString('utf8')] : [];
  });
  return texts.length === 0 ? undefined : texts.join('\n');
}

/** A deploy that fails after signing says so on the inbox, unsigned and best effort. */
async function failedAfterSigning(ctx: CommandContext, at: MainContext, step: string) {
  const text = `deploy of ${at.main} failed at the ${step}; ${NOTHING}`;
  try {
    await postComment(at.config.repo, at.config.inbox_issue, text, { env: at.env });
  } catch (err) {
    ctx.io.stderr.write(
      `warning: could not post "${text}" on the inbox: ${(err as Error).message}\n`,
    );
  }
}

/**
 * An unhealthy release (AC-060): the rollback steps, then the Owner's choice to switch back,
 * default no; a first deploy has nothing to switch back to. Returns the summary's status and what
 * the refusal says happened.
 */
async function offerSwitchBack(
  ctx: CommandContext,
  switched: Switched,
  release: string,
  rollback: DeployView['rollback'],
): Promise<{ status: string; outcome: string }> {
  const steps = rollback.flatMap((r) => [
    `Rollback steps for #${String(r.issue)}:`,
    ...r.notes.flatMap((n) => [
      `  quoted from ${visible(n.path)} on ${n.source}:`,
      ...n.steps.map((line) => `  > ${visible(line)}`),
    ]),
  ]);
  ctx.io.stdout.write(
    `${(steps.length > 0 ? steps : ['No item shipped, so the release notes give no rollback steps']).join('\n')}\n`,
  );
  const kept = {
    status: 'unhealthy, kept running',
    outcome: `the new release ${release} keeps running`,
  };
  if (!switched.hadUnit)
    return { ...kept, outcome: `there is no earlier release to switch back to; ${kept.outcome}` };
  const target = switched.previous ?? 'its previous unit';
  const answer = await ctx.ask(`Switch back to ${target}? [y/N] `);
  if (!['y', 'yes'].includes(answer.trim().toLowerCase())) return kept;
  const back = switched.switchBack();
  const status =
    back.failed.length === 0
      ? `unhealthy, switched back to ${target}`
      : `unhealthy, switch back to ${target} failed: ${back.failed.join('; ')}`;
  return { status, outcome: back.text };
}

/**
 * A healthy deploy's `deploy-healthy` record (slice 23d; Owner decisions 2026-10-15): the Deploy
 * health summary, then the passphrase, no second question; returns the posted comment's id. A
 * wrong or empty passphrase or a failed post keeps the release running, as an unhealthy deploy
 * that keeps running does: no cleanup and no `deploys.log` line, so the next deploy redeploys
 * the same commit and signs both records.
 */
async function signHealthy(
  ctx: CommandContext,
  project: Project,
  at: MainContext,
  health: HealthView,
): Promise<string> {
  try {
    const summary = buildSummary({
      ...{ gate: 'deploy-healthy', commit: at.main, health },
      issue: await viewIssue(project, at.config.inbox_issue),
    });
    if (!summary.ok)
      throw new RefusedError(`the summary is incomplete: ${summary.missing.join('; ')}`);
    ctx.io.stdout.write(`${summary.text}\n`);
    ctx.io.stdout.write(
      'An empty passphrase skips the deploy-healthy record: the release keeps running, without cleanup or a deploys.log line\n',
    );
    const id = await postSigned(ctx, project, {
      ...{ repo: at.config.repo, issue: at.config.inbox_issue, gate: 'deploy-healthy' },
      ...{ head: at.main, deployed: health.deployed.nonce },
      ...{ timestamp: recordTimestamp(ctx.now()), nonce: newNonce() },
    });
    ctx.io.stdout.write(
      `Signed the deploy-healthy record: comment ${id} on #${String(at.config.inbox_issue)}\n`,
    );
    return id;
  } catch (err) {
    throw new RefusedError(
      `the deploy-healthy record was not signed: ${(err as Error).message}; ${health.release} keeps running; run factory deploy again to redeploy ${at.main} and sign it`,
    );
  }
}

export function deploy(ctx: CommandContext): Promise<number> {
  const home = ctx.env.HOME ?? homedir();
  return withDeployLock(home, async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'factory-deploy-'));
    try {
      const at = checkedMain(ctx.cwd, ctx.env, home, scratch);
      assertNewestKey(at, NOTHING);
      // The release notes on the log branch are read as fetched now, once.
      const logHead = fetchBranch(at, 'claude/factory-log', NOTHING);
      const app = appFolder(home, at.config.repo);
      // Everything the switch-over needs is checked before anything is exported.
      checkSettings(app);
      assertUserManager(ctx.env);
      const port = at.config.app_port;
      await assertPortFree(userUnits(home), at.config.repo, port);
      // Probed on an empty folder before anything is exported: without the sandbox, nothing is written.
      const probe = join(scratch, 'probe');
      mkdirSync(probe);
      deployRunner(app, probe, ctx.env);
      await confirmPause(ctx, at, 'Deploy anyway while paused?', NOTHING);
      const log = deploysLogPath(home, at.config.repo);
      const shipped = shippedSince(at, lastDeploy(log)?.main);
      const verified = await verifyShipped(at, shipped);
      const since =
        shipped.since === undefined
          ? 'the baseline'
          : `the last deploy (${shipped.since.slice(0, 12)})`;
      const items = shipped.items.map((i) => `#${String(i.issue)}`);
      ctx.io.stdout.write(
        `Since ${since}: ${String(shipped.commits.length)} commit(s); ${items.length === 0 ? 'no items merged' : `re-verified the approvals of ${items.join(', ')}`}\n`,
      );
      const ci = await ciOnMain(at);
      const issues = verified.map((i) => i.issue);
      const rollback = rollbackFor(releaseNotes(at, logHead), issues);
      const project = {
        ...{ repo: at.config.repo, inboxIssue: at.config.inbox_issue },
        ...{ home, cwd: ctx.cwd, env: at.env },
      };
      const view: DeployView = {
        ...{ main: at.main, since: shipped.since, commits: shipped.commits.length },
        items: await Promise.all(
          verified.map(async (i) => ({ ...i, title: (await viewIssue(project, i.issue)).title })),
        ),
        ...{ others: shipped.others, ci, rollback },
      };
      const summary = buildSummary({
        ...{ gate: 'deployed', kind: 'deploy', commit: at.main, deploy: view },
        issue: await viewIssue(project, at.config.inbox_issue),
        files: { events: eventsAt(at, verified) },
      });
      if (!summary.ok)
        throw new RefusedError(
          `not deploying: the approval summary is incomplete:\n  ${summary.missing.join('\n  ')}`,
        );
      ctx.io.stdout.write(`${summary.text}\n`);
      assertPassphraseTerminal(ctx.stdinIsTTY);
      const answer = await ctx.ask(`Deploy ${at.main} to this laptop? [y/N] `);
      if (!['y', 'yes'].includes(answer.trim().toLowerCase()))
        throw new RefusedError(`the Owner did not confirm the deploy; ${NOTHING}`);
      const nonce = newNonce();
      const record = await postSigned(ctx, project, {
        ...{ repo: at.config.repo, issue: at.config.inbox_issue, gate: 'deployed', head: at.main },
        ...{ timestamp: recordTimestamp(ctx.now()), nonce },
      });
      ctx.io.stdout.write(
        `Signed the deployed record: comment ${record} on #${String(at.config.inbox_issue)}\n`,
      );
      const units = userUnits(home);
      let step = 'export';
      let release = '';
      let switched: Switched;
      try {
        release = newRelease(app, ctx.cwd, at.main, ctx.now(), ctx.env);
        ctx.io.stdout.write(`Exported main's verified ${at.main} to ${release}\n`);
        step = 'build';
        buildRelease(deployRunner(app, release, ctx.env), at.main, ctx.io.stdout);
        step = 'switch';
        switched = await switchService(
          units,
          {
            ...{ repo: at.config.repo, release: basename(release), port, home },
            ...{ factory: factoryRoot(), program: factoryProgram() },
          },
          ctx.env,
        );
      } catch (err) {
        await failedAfterSigning(ctx, at, step);
        throw err;
      }
      ctx.io.stdout.write(
        `Switched the service to ${basename(release)}; it answered on 127.0.0.1:${String(port)}\n`,
      );
      const name = unitName(at.config.repo);
      const unit = { env: ctx.env, name, pid: switched.pid };
      const health = await checkHealth(port, unit, ctx.healthMs);
      ctx.io.stdout.write(`Health: ${health.answer}\n`);
      const unhealthy = health.healthy
        ? undefined
        : await offerSwitchBack(ctx, switched, basename(release), view.rollback);
      let backup: string;
      try {
        backup = lastBackup(ctx.env, at.config.repo);
      } catch (err) {
        backup = `could not be read: ${(err as Error).message}`;
      }
      ctx.io.stdout.write(`Backup: ${backup}\n`);
      const text = healthSummary({
        ...{ repo: at.config.repo, at: ctx.now(), main: at.main, release: basename(release) },
        status: unhealthy?.status ?? 'healthy',
        record: { id: record, inbox: at.config.inbox_issue, nonce },
        ...{ port, health, backup },
      });
      try {
        const path = `.factory/ops/health/${stamp(ctx.now())}.md`;
        pushHealth(at, scratch, path, text);
        ctx.io.stdout.write(`Wrote the health summary ${path} on claude/factory-log\n`);
      } catch (err) {
        ctx.io.stderr.write(`warning: ${(err as Error).message}\n`);
        ctx.io.stdout.write(text);
      }
      if (unhealthy !== undefined)
        throw new RefusedError(`the health check failed: ${health.answer}; ${unhealthy.outcome}`);
      const healthy = await signHealthy(ctx, project, at, {
        ...{ main: at.main, release: basename(release), answer: health.answer },
        ...{ deployed: { id: record, nonce }, rollback: view.rollback },
      });
      // Old releases go only once the new one is healthy and signed: a switch back needs the
      // previous one, and so does a redeploy after a signing failure.
      const cleanup = cleanReleases(app, units, at.config.repo, switched.previous);
      if (cleanup.removed.length > 0)
        ctx.io.stdout.write(`Removed old releases: ${cleanup.removed.join(', ')}\n`);
      for (const line of cleanup.failed) ctx.io.stderr.write(`warning: ${line}\n`);
      appendDeploy(log, {
        ...{ at: ctx.now().toISOString(), main: at.main, release: basename(release) },
        ...{ record, healthy },
      });
      return ExitCode.Ok;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
