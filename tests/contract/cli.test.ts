import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMANDS, runCli, type CliDeps, type CommandSpec } from '../../src/cli/commands.js';
import { ExitCode, RefusedError } from '../../src/cli/env.js';
import type { Alert } from '../../src/model/types.js';

const fakeBin = fileURLToPath(new URL('../helpers/bin', import.meta.url));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr interleaved in write order. */
  all: string;
}

const LAPTOP_ONLY = [
  'approve',
  'merge',
  'deploy',
  'resume',
  'keygen',
  'config',
  'release',
  'benchmark',
];

/** A minimal valid argv for each command, so only the check under test can refuse. */
const ARGV: Record<string, string[]> = {
  new: ['new', 'a pitch'],
  adopt: ['adopt', 'owner/repo'],
  run: ['run'],
  dispatch: ['dispatch'],
  approve: ['approve', '12'],
  merge: ['merge', '13'],
  deploy: ['deploy'],
  pause: ['pause'],
  resume: ['resume'],
  upgrade: ['upgrade', 'v1.1.0'],
  inbox: ['inbox'],
  mcp: ['mcp'],
  hook: ['hook', 'stop'],
  ci: ['ci', 'size'],
  keygen: ['keygen'],
  config: ['config', 'set', 'retry_limit', '4'],
  release: ['release', 'v1.0.0'],
  benchmark: ['benchmark', 'init'],
};

/** PATH holding only the named real tools (plus the fake gh when asked). */
function pathWith(tools: string[], withFakeGh: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-path-'));
  for (const tool of tools) {
    for (const prefix of ['/usr/bin', '/bin', '/usr/local/bin']) {
      try {
        symlinkSync(join(prefix, tool), join(dir, tool));
        break;
      } catch {
        // try the next prefix
      }
    }
  }
  return withFakeGh ? `${fakeBin}:${dir}` : dir;
}

async function cli(
  argv: string[],
  overrides: Partial<Omit<CliDeps, 'stdout' | 'stderr'>> = {},
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const all: string[] = [];
  const code = await runCli(argv, {
    stdout: { write: (s: string) => void (out.push(s), all.push(s)) },
    stderr: { write: (s: string) => void (err.push(s), all.push(s)) },
    env: { PATH: process.env.PATH ?? '' },
    stdinIsTTY: true,
    unreadAlerts: () => Promise.resolve([]),
    ...overrides,
  });
  return { code, stdout: out.join(''), stderr: err.join(''), all: all.join('') };
}

function command(
  run: NonNullable<CommandSpec['run']>,
  extra: Partial<CommandSpec> = {},
): Record<string, CommandSpec> {
  return {
    greet: {
      summary: 'test command',
      usage: 'factory greet [--loud] <name>',
      laptopOnly: false,
      requires: [],
      options: { loud: { type: 'boolean' } },
      positionals: { min: 1, max: 1 },
      run,
      ...extra,
    },
  };
}

const alerts: Alert[] = [
  {
    id: '01J00000000000000000000001',
    urgency: 'urgent',
    kind: 'tampering',
    text: 'owner:approved on #7 has no record',
  },
  {
    id: '01J00000000000000000000002',
    urgency: 'info',
    kind: 'escalation',
    text: '#9 hit the retry limit',
  },
];

describe('factory CLI contract (contracts/cli.md)', () => {
  it('registers exactly the commands of the contract', () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(Object.keys(ARGV).sort());
  });

  describe('exit 0: success', () => {
    it('runs a command and passes its positionals and options', async () => {
      const r = await cli(['greet', '--loud', 'owner'], {
        commands: command((ctx) => {
          ctx.io.stdout.write(`hi ${ctx.positionals[0] ?? ''} ${String(ctx.options.loud)}\n`);
          return Promise.resolve(ExitCode.Ok);
        }),
      });
      expect(r).toMatchObject({ code: 0, stdout: 'hi owner true\n', stderr: '' });
    });

    it('prints the usage for --help', async () => {
      const r = await cli(['--help']);
      expect(r.code).toBe(0);
      for (const name of Object.keys(COMMANDS)) expect(r.stdout).toContain(`factory ${name}`);
    });

    it('prints one command usage for <command> --help', async () => {
      const r = await cli(['approve', '--help']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('factory approve <issue|pr> [spec|waiver <waives>]');
    });
  });

  describe('exit 1: refused', () => {
    it('when the command refuses', async () => {
      const r = await cli(['greet', 'x'], {
        commands: command(() => Promise.reject(new RefusedError('gate not passed'))),
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('gate not passed');
    });

    it('when the command fails unexpectedly (fail closed)', async () => {
      const r = await cli(['greet', 'x'], {
        commands: command(() => Promise.reject(new Error('boom'))),
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('boom');
    });

    it('for a command not built yet', async () => {
      const r = await cli(['pause']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('not implemented');
    });
  });

  describe('exit 2: usage error', () => {
    it.each([
      ['no command', []],
      ['an unregistered command', ['frobnicate']],
      ['an unknown option', ['run', '--bogus']],
      ['a missing argument', ['approve']],
      ['too many arguments', ['inbox', 'extra']],
      ['a value given to a flag', ['run', '--once=yes']],
    ])('for %s', async (_label, argv) => {
      const r = await cli(argv);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/usage: factory/i);
    });
  });

  describe('exit 3: environment error', () => {
    it('when gh is missing', async () => {
      const r = await cli(ARGV.approve ?? [], { env: { PATH: pathWith(['ssh-keygen'], false) } });
      expect(r.code).toBe(3);
      expect(r.stderr).toContain('`gh` not found');
    });

    it('when ssh-keygen is missing', async () => {
      const r = await cli(ARGV.approve ?? [], { env: { PATH: pathWith([], true) } });
      expect(r.code).toBe(3);
      expect(r.stderr).toContain('`ssh-keygen` not found');
    });

    it('when PATH is empty', async () => {
      const r = await cli(ARGV.keygen ?? [], { env: {} });
      expect(r.code).toBe(3);
    });
  });

  describe('laptop-only commands', () => {
    it.each(LAPTOP_ONLY)('%s refuses when CLAUDE_CODE_REMOTE is set', async (name) => {
      const r = await cli(ARGV[name] ?? [], {
        env: { PATH: process.env.PATH ?? '', CLAUDE_CODE_REMOTE: 'true' },
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`factory ${name} runs only on the Owner's laptop`);
      expect(r.stderr).toContain('CLAUDE_CODE_REMOTE');
    });

    it.each(LAPTOP_ONLY)('%s refuses when stdin is not a TTY', async (name) => {
      const r = await cli(ARGV[name] ?? [], { stdinIsTTY: false });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`factory ${name} runs only on the Owner's laptop`);
      expect(r.stderr).toContain('terminal');
    });

    it('refuses even when CLAUDE_CODE_REMOTE is set to an empty string', async () => {
      const r = await cli(ARGV.approve ?? [], {
        env: { PATH: process.env.PATH ?? '', CLAUDE_CODE_REMOTE: '' },
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("runs only on the Owner's laptop");
    });

    it('refuses before checking for tools', async () => {
      const r = await cli(ARGV.merge ?? [], { env: { CLAUDE_CODE_REMOTE: '1' } });
      expect(r.code).toBe(1);
    });

    it.each(Object.keys(ARGV).filter((n) => !LAPTOP_ONLY.includes(n)))(
      '%s is not laptop-only',
      async (name) => {
        const r = await cli(ARGV[name] ?? [], {
          env: { PATH: process.env.PATH ?? '', CLAUDE_CODE_REMOTE: 'true' },
          stdinIsTTY: false,
        });
        expect(r.stderr).not.toContain("runs only on the Owner's laptop");
      },
    );
  });

  describe('unread Owner-inbox alerts come first (AC-075)', () => {
    it('prints unread alerts before the command output', async () => {
      const r = await cli(['greet', 'x'], {
        unreadAlerts: () => Promise.resolve(alerts),
        commands: command((ctx) => {
          ctx.io.stdout.write('COMMAND OUTPUT\n');
          return Promise.resolve(ExitCode.Ok);
        }),
      });
      expect(r.code).toBe(0);
      const first = r.stdout.indexOf('owner:approved on #7 has no record');
      const second = r.stdout.indexOf('#9 hit the retry limit');
      const output = r.stdout.indexOf('COMMAND OUTPUT');
      expect(first).toBeGreaterThanOrEqual(0);
      expect(second).toBeGreaterThan(first);
      expect(output).toBeGreaterThan(second);
      expect(r.stdout).toContain('URGENT');
      expect(r.stdout).toContain('factory inbox');
    });

    it('prints them before a laptop-only refusal', async () => {
      const r = await cli(ARGV.approve ?? [], {
        unreadAlerts: () => Promise.resolve(alerts),
        stdinIsTTY: false,
      });
      expect(r.code).toBe(1);
      expect(r.all.indexOf('has no record')).toBeLessThan(
        r.all.indexOf("runs only on the Owner's laptop"),
      );
    });

    it('prints nothing extra when there are no unread alerts', async () => {
      const r = await cli(['greet', 'x'], {
        commands: command((ctx) => {
          ctx.io.stdout.write('only this\n');
          return Promise.resolve(ExitCode.Ok);
        }),
      });
      expect(r.stdout).toBe('only this\n');
    });

    it('warns and continues when the inbox cannot be read', async () => {
      const r = await cli(['greet', 'x'], {
        unreadAlerts: () => Promise.reject(new Error('gh: not logged in')),
        commands: command(() => Promise.resolve(ExitCode.Ok)),
      });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('could not read the Owner inbox: gh: not logged in');
    });

    it.each([['hook'], ['mcp'], ['ci']])(
      'keeps the %s protocol output clean (session and CI channels, not the laptop)',
      async (name) => {
        let asked = false;
        const r = await cli(ARGV[name] ?? [], {
          unreadAlerts: () => {
            asked = true;
            return Promise.resolve(alerts);
          },
        });
        expect(asked).toBe(false);
        expect(r.all).not.toContain('has no record');
      },
    );
  });
});
