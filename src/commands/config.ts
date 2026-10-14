// `factory config set <key> <value>` (contracts/cli.md, FR-007f, AC-090): the Owner changes one
// `.factory/config` field as an Owner-signed commit on main, on the laptop only.
//
// Only the fields in SETTABLE change this way (Owner decision 2026-10-11); every other key is
// refused, naming the command that sets it. The config rules still apply (`size_limit_lines`
// only goes down and `coverage_min` only up, against the release's values), and `agents: cloud`
// needs the same consent as `factory new`. Main's first-parent history must be Owner-signed
// first, checked with the laptop's ledger and key lists, and the change is built from the config
// at the commit that check ended on. The commit is built on a temporary index from that tree, so
// nothing staged or edited in the working copy is swept in; it is verified with the key lists the
// next walk will use before it is pushed, and a rejected push changes nothing.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { laptopKeys, releaseKeysFor } from '../approvals/keys.js';
import { ownerKeyPath } from '../approvals/sign.js';
import type { CommandContext } from '../cli/commands.js';
import { ExitCode, RefusedError, UsageError } from '../cli/env.js';
import { ledgerPath, signedUnder, verifyFirstParent } from '../git/history.js';
import { signedCommitTree } from '../git/sign.js';
import { CONFIG_PATH } from '../install/project.js';
import { ConfigError, parseConfig } from '../model/config.js';
import { askConsent } from './new.js';
import { projectHere } from './pause.js';

const SETTABLE: readonly string[] = [
  'agents',
  'parallel_sessions',
  'retry_limit',
  'size_limit_lines',
  'coverage_min',
  'app_port',
];
const SET_BY: Readonly<Record<string, string>> = {
  factory_release: 'factory upgrade',
  baseline: 'factory new/adopt',
  repo: 'factory new/adopt',
  inbox_issue: 'factory new/adopt',
  profile: 'factory new/adopt',
};

export async function config(ctx: CommandContext): Promise<number> {
  const [verb = '', key = '', value = ''] = ctx.positionals;
  if (verb !== 'set') throw new UsageError(`expected config set <key> <value>, got ${verb}`);
  if (!SETTABLE.includes(key)) {
    const by = SET_BY[key];
    throw new RefusedError(
      by === undefined ? `${key} is not a .factory/config key` : `${key} is set by ${by}`,
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new UsageError(`not a plain value: ${value}`);

  const project = await projectHere(ctx);
  const env = project.env ?? ctx.env;
  const run = (args: readonly string[], extra: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: project.cwd,
      env: { ...env, ...extra },
      encoding: 'utf8',
    });
    if (result.error !== undefined)
      throw new RefusedError(`cannot run git: ${result.error.message}`);
    return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr.trim() };
  };

  const scratch = mkdtempSync(join(tmpdir(), 'factory-config-'));
  try {
    const fetched = run(['fetch', '-q', 'origin', 'main']);
    if (!fetched.ok) throw new RefusedError(`cannot fetch main: ${fetched.err}`);
    const configAt = (ref: string) => {
      const shown = run(['show', `${ref}:${CONFIG_PATH}`]);
      if (!shown.ok) throw new RefusedError(`${ref} has no ${CONFIG_PATH}`);
      return shown.out;
    };
    const tip = parseConfig(configAt('origin/main'));
    const laptop = laptopKeys(project.home);
    const keysFor = releaseKeysFor(env, scratch, laptop);
    const history = verifyFirstParent(project.cwd, tip.baseline, keysFor, {
      env,
      ledger: ledgerPath(project.home, tip.repo),
      anchorKeys: laptop,
    });
    if (!history.ok)
      throw new RefusedError(
        `main has a first-parent commit not signed by the Owner: ${history.reason}`,
      );
    // The walk may have fetched again: the change is built on the commit it verified.
    const text = configAt(history.head);
    const before = parseConfig(text);

    const line = `${key}: ${value}`;
    const current = new RegExp(`^${key}:.*$`, 'm');
    const old = current.exec(text)?.[0];
    if (old === line) {
      ctx.io.stdout.write(`${line} is already set on main\n`);
      return ExitCode.Ok;
    }
    const next = old === undefined ? `${text}\n${line}\n` : `${text.replace(current, line)}\n`;
    try {
      parseConfig(next);
    } catch (err) {
      if (err instanceof ConfigError) throw new RefusedError(err.message);
      throw err;
    }
    if (key === 'agents' && value === 'cloud' && (await askConsent(ctx)) !== 'cloud')
      throw new RefusedError('agents: cloud needs the Owner to choose cloud; nothing changed');

    ctx.io.stdout.write(
      `${CONFIG_PATH} on main at ${history.head.slice(0, 12)}:\n- ${old ?? `${key}: (not set)`}\n+ ${line}\n`,
    );
    // Main's tree with only the config replaced, on an index of its own.
    const index = { GIT_INDEX_FILE: join(scratch, 'index') };
    const step = (args: readonly string[], input?: string) => {
      const result = spawnSync('git', args, {
        cwd: project.cwd,
        env: { ...env, ...index },
        encoding: 'utf8',
        ...(input === undefined ? {} : { input }),
      });
      if (result.error !== undefined || result.status !== 0)
        throw new RefusedError(`git ${args[0] ?? ''} failed: ${result.stderr.trim()}`);
      return result.stdout.trim();
    };
    step(['read-tree', history.head]);
    const blob = step(['hash-object', '-w', '--stdin'], next);
    step(['update-index', '--cacheinfo', `100644,${blob},${CONFIG_PATH}`]);
    const tree = step(['write-tree']);
    const signing = { repo: project.cwd, keyPath: ownerKeyPath(project.home), env };
    const sha = signedCommitTree(
      { ...signing, stdinIsTTY: ctx.stdinIsTTY },
      tree,
      history.head,
      `config: ${line}`,
    );

    // The next walk checks this commit with the pin at its parent; one it rejects could never
    // leave main, and the line would stop for good.
    if (!signedUnder(project.cwd, keysFor(before.factory_release), sha, env))
      throw new RefusedError(
        'your signing key is not accepted by the release pinned on main; nothing was pushed',
      );

    const pushed = run(['push', '-q', 'origin', `${sha}:refs/heads/main`]);
    if (!pushed.ok) {
      const remote = run(['ls-remote', 'origin', 'refs/heads/main']).out.split(/\s/)[0];
      throw new RefusedError(
        remote !== undefined && remote !== '' && remote !== history.head
          ? `main moved since ${history.head.slice(0, 12)}, so the push was rejected and nothing changed; run config set again`
          : `the push was refused: ${pushed.err}; nothing changed`,
      );
    }
    ctx.io.stdout.write(
      `${line} is set on main: ${sha.slice(0, 12)}\nrun git pull --ff-only to update your checkout\n`,
    );
    return ExitCode.Ok;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
