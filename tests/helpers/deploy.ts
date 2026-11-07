// The setup shared by the two `factory deploy` integration files (T053): deploy-command.test.ts
// and deploy-command-health.test.ts, split so CI runs them in parallel. A deployable product on
// main with its own port, a fake `systemctl --user`, and item #7 merged with its release note.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import { extractFromComment, parse } from '../../src/approvals/record.js';
import { deploysLogPath } from '../../src/deploy/deploys-log.js';
import { appFolder } from '../../src/deploy/sandbox.js';
import { unitName, unitRelease } from '../../src/deploy/service.js';
import { readState } from './fake-gh.js';
import { runGit, type Files, type TestRepo } from './git-repo.js';
import {
  type CliOver,
  ITEM,
  ITEM_BRANCH,
  LOG_BRANCH,
  type MergeSetup,
  REPO,
  mergeSetup,
  onMain,
  owner,
  pushRunAt,
} from './merge-deploy.js';

export const LOCK = {
  ...{ name: 'p', version: '1.0.0', lockfileVersion: 3, requires: true },
  packages: { '': { name: 'p', version: '1.0.0' } },
};
/**
 * The product on main: an empty install, `build` as its build script, and whether it serves; a
 * string is what its `/health` answers with a 503, else it answers 200 `{"status":"ok"}`.
 */
export const product = (build: string, serves: boolean | string = true): Files => ({
  'package.json': JSON.stringify({ name: 'p', version: '1.0.0', scripts: { build } }),
  'package-lock.json': JSON.stringify(LOCK),
  'build.mjs':
    "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('dist');\nwriteFileSync('dist/out.txt', 'built');\n",
  ...(serves === false ? {} : { serves: serves === true ? '' : serves }),
});
export const releasesOf = (home: string) => {
  const { releases } = appFolder(home, REPO);
  return existsSync(releases) ? readdirSync(releases).map((n) => join(releases, n)) : [];
};
export const systemd = {
  PATH: `${join(fileURLToPath(new URL('../helpers/systemd', import.meta.url)))}:${process.env.PATH ?? ''}`,
};
/**
 * Each file takes its ports from its own base, so two files running in parallel workers, whose
 * pids are often next to each other, never take the same port.
 */
let nextPort = 0;
export function portsFrom(base: number): void {
  nextPort = base + (process.pid % 2_000) * 4;
}
/** The next port of this file's range. */
export const takePort = () => nextPort++;

/** A project ready to deploy: main holds the product and its port; the settings file is there. */
export function deployable(files: Files, o: MergeSetup = {}) {
  const t = mergeSetup(o);
  const port = takePort();
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
export const releaseIn = (unit: string) => unitRelease(readFileSync(unit, 'utf8'), REPO);
export const [APP, BACKUP, TIMER] = [
  unitName(REPO),
  unitName(REPO, 'backup'),
  unitName(REPO, 'backup', 'timer'),
];
export const deployLog = (home: string) => deploysLogPath(home, REPO);
export const deployLines = (home: string) =>
  existsSync(deployLog(home))
    ? readFileSync(deployLog(home), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { main: string; release: string; healthy?: string })
    : [];
export const NOTE_PATH = '.factory/releases/v1.md';
export const NOTE = [
  ...['# Release v1', '', '- #7 Add login', '', '## Rollback', ''],
  ...['1. Run factory deploy at the previous commit.', '', '## Notes', '', 'Nothing else.', ''],
].join('\n');
/** `files` committed on claude/factory-log as origin has it, or cut from main, and pushed. */
export function onLog(repo: TestRepo, files: Files): string {
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
export function mergeItem(repo: TestRepo, note: string | null = NOTE): string {
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
export const nonceOf = (body: string) => /\bnonce: ([0-9a-f]{32})\b/.exec(body)?.[1] ?? '';
/** The comments on the Owner inbox as the fake GitHub holds them. */
export const inboxComments = () =>
  readState().repos[REPO]?.issues.find((i) => i.number === 1)?.comments ?? [];
/** The signed record a comment posts, as its fields. */
export const recordOf = (body: string) => parse(extractFromComment(body).text);
