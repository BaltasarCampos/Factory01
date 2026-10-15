// The deploy's health check and health summary (T069, AC-015, AC-060, slice 23c-2; Owner decisions
// 2026-10-14). After the switch, `GET /health` on the app's port must answer 200 with
// `{"status":"ok"}` within 30 s, the path the skeleton serves, while the unit keeps the main
// process the switch saw; each request gets 2 s in all, at most 4 KiB of an answer is read, and
// what is shown goes through `visible()`. The summary goes to `.factory/ops/health/<stamp>.md`
// on `claude/factory-log`: a commit made with plumbing in the Owner's checkout, a temporary index
// and `commit-tree`, never a working tree, on top of the branch as fetched (or main when there is
// none), pushed fast-forward only and never replacing a file; an agent's push in between makes it
// fetch and try again. It is unsigned: agents push to that branch too, so it is never release
// evidence on its own (23d's `deploy-healthy` record is).
import { request } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { LOG_BRANCH } from '../ci/append-only.js';
import { RefusedError } from '../cli/env.js';
import { safeGit } from '../git/diff.js';
import { fetchBranch, pushBranch, type MainContext } from '../merge/context.js';
import { visible } from '../notify/summary.js';
import { mainPid } from './service.js';

const HEALTH_MS = 30_000;
const REQUEST_MS = 2000;
const MAX_ANSWER = 4096;
const TRIES = 3;
const AUTHOR = ['user', 'author', 'committer'].flatMap((who) => [
  ...['-c', `${who}.name=factory deploy`, '-c', `${who}.email=deploy@invalid`],
]);

export interface Health {
  healthy: boolean;
  /** What the check saw, shown: `GET /health answered 200 {"status":"ok"}`, or why it is unhealthy. */
  answer: string;
}

/**
 * One `GET /health`: its status and at most the first 4 KiB of its body, or nothing when no
 * complete answer came within `limit` ms. The limit is on the whole request, so an app that drips
 * its answer is cut off too.
 */
function ask(port: number, limit: number): Promise<{ status: number; body: string } | undefined> {
  return new Promise((done) => {
    const req = request({ host: '127.0.0.1', port, path: '/health' }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks).subarray(0, MAX_ANSWER).toString('utf8');
        done({ status: res.statusCode ?? 0, body });
      };
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= MAX_ANSWER) res.destroy();
      });
      res.on('end', finish);
      res.on('close', finish);
    });
    // Resolved first, so the `close` the destroy causes changes nothing.
    const timer = setTimeout(() => {
      done(undefined);
      req.destroy();
    }, limit);
    req.on('error', () => {
      clearTimeout(timer);
      done(undefined);
    });
    req.end();
  });
}

const ok = (body: string) => {
  try {
    return (JSON.parse(body) as { status?: unknown }).status === 'ok';
  } catch {
    return false;
  }
};

/**
 * The health check, retried for 30 s; the unit must keep the main process `pid` throughout. Each
 * request gets at most 2 s and never more than what is left, so the check ends within about 30 s;
 * an error, such as `systemctl show` failing, counts as unhealthy, with the error as the answer.
 */
export async function checkHealth(
  port: number,
  unit: { env: NodeJS.ProcessEnv; name: string; pid: string },
  ms = HEALTH_MS,
): Promise<Health> {
  const deadline = Date.now() + ms;
  let answer = `GET /health: no answer within ${String(ms / 1000)} s`;
  try {
    for (;;) {
      const got = await ask(port, Math.max(1, Math.min(REQUEST_MS, deadline - Date.now())));
      if (got !== undefined)
        answer = `GET /health answered ${String(got.status)} ${visible(got.body)}`;
      if (mainPid(unit.env, unit.name) !== unit.pid)
        return { healthy: false, answer: `${answer}, and the service no longer runs ${unit.pid}` };
      if (got?.status === 200 && ok(got.body)) return { healthy: true, answer };
      if (Date.now() >= deadline) return { healthy: false, answer };
      await sleep(500);
    }
  } catch (err) {
    return { healthy: false, answer: `error during the check: ${(err as Error).message}` };
  }
}

export interface HealthFacts {
  repo: string;
  at: Date;
  main: string;
  release: string;
  status: string;
  record: { id: string; inbox: number; nonce: string };
  port: number;
  /** The start check's steady window, in ms. */
  steadyMs: number;
  health: Health;
  backup: string;
}

export function healthSummary(f: HealthFacts): string {
  return [
    `# Health summary: ${f.repo} at ${f.at.toISOString()}`,
    '',
    'Written by factory deploy on the laptop; unsigned, so it is not release evidence.',
    '',
    `- Version: main ${f.main}, release ${f.release}`,
    `- Status: ${f.status}`,
    `- Deployed record: comment ${f.record.id} on #${String(f.record.inbox)}, nonce ${f.record.nonce}`,
    '- Checks:',
    `  - Start check: answered on 127.0.0.1:${String(f.port)}, one main process for ${String(f.steadyMs / 1000)} s`,
    `  - Health: ${f.health.answer}`,
    `  - Backup: ${f.backup}`,
    '',
  ].join('\n');
}

/**
 * Commits `text` at `path` on `claude/factory-log` and pushes it, fast-forward only, trying three
 * times; a file already at `path` fails a try too. Returns the commit, or refuses with the last
 * reason.
 */
export function pushHealth(at: MainContext, scratch: string, path: string, text: string): string {
  const git = (args: readonly string[], input?: string, index?: string) => {
    const r = safeGit(at.cwd, args, at.env, input, index);
    if (r.status !== 0) throw new RefusedError(`git ${args[0] ?? ''} failed: ${r.stderr}`);
    return r.stdout.toString('utf8').trim();
  };
  const blob = git(['hash-object', '-w', '--stdin'], text);
  let why = '';
  for (let n = 1; n <= TRIES; n += 1) {
    try {
      const parent = fetchBranch(at, LOG_BRANCH, 'the summary was not pushed') ?? at.main;
      // A summary never replaces a file: one already there fails this try, as a rejected push does.
      if (safeGit(at.cwd, ['cat-file', '-e', `${parent}:${path}`], at.env).status === 0) {
        why = `${path} already exists on ${LOG_BRANCH} at ${parent.slice(0, 12)}`;
        continue;
      }
      const index = join(scratch, `health-index-${String(n)}`);
      git(['read-tree', parent], undefined, index);
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], undefined, index);
      const tree = git(['write-tree'], undefined, index);
      const message = `Health summary: ${path}`;
      const commit = git([
        ...AUTHOR,
        ...['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', parent, '-m', message],
      ]);
      const failed = pushBranch(at, commit, LOG_BRANCH);
      if (failed === undefined) return commit;
      why = failed;
    } catch (err) {
      why = (err as Error).message;
    }
  }
  throw new RefusedError(
    `the health summary could not be pushed to ${LOG_BRANCH} after ${String(TRIES)} tries: ${why}`,
  );
}
