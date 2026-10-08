// Contract tests for the factory MCP tools (contracts/mcp-tools.md, FR-022, R7): requests and
// events only, never a label; session facts come from the launcher and the working copy, never
// from the caller.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/commands.js';
import { roleVersion } from '../../src/events/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { calls, seedState } from '../helpers/fake-gh.js';
import { tempDir } from '../helpers/keys.js';

const SHA40 = '3f9a0c1d2e3f4a5b6c7d8e9f0011223344556677';
const FEATURE = 'specs/42-add-login';
const NOW = new Date('2026-10-08T10:00:00.000Z');
const ROLE_FILE = '---\nname: builder\nmodel: sonnet\ntools: Read\nversion: 1\n---\nBuilder.\n';

/** A Builder's working copy on the item branch, as the launcher's clone would hold it. */
function workingCopy(): string {
  const dir = tempDir();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  write(
    '.factory/config',
    `factory_release: v1.0.0@${SHA40}\nagents: local\nprofile: typescript\nrepo: owner/project\ninbox_issue: 1\n`,
  );
  write('.claude/agents/builder.md', ROLE_FILE);
  write('.specify/feature.json', JSON.stringify({ feature_directory: FEATURE }));
  write(
    `${FEATURE}/.station.json`,
    JSON.stringify({
      ...{ item: 42, station: 4, role: 'builder', branch: 'claude/42-add-login' },
      ...{ task: 'T007', files: ['src/login.ts'], issued_at: '2026-10-08T09:00:00Z' },
    }),
  );
  return dir;
}

/** The project on the fake GitHub: inbox #1 with `inboxLabels`, item #42 in `state`. */
function github(state = 'building', inboxLabels: string[] = []) {
  seedState({
    repos: {
      'owner/project': {
        issues: [
          { number: 1, title: 'Owner inbox', labels: inboxLabels },
          { number: 42, title: 'Add login', labels: [`state:${state}`, 'owner:approved'] },
        ],
      },
    },
  });
}

const SESSION = { FACTORY_ROLE: 'builder', FACTORY_SESSION: 'sess-1', FACTORY_STATION: '4' };

async function connect(dir: string, env: NodeJS.ProcessEnv = { ...process.env, ...SESSION }) {
  const server = createServer({ cwd: dir, env, now: () => NOW });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content as { type: string; text: string }[];
    return {
      isError: result.isError === true,
      value: JSON.parse(first?.text ?? 'null') as unknown,
    };
  };
  return { client, call };
}

function events(dir: string): Record<string, unknown>[] {
  const path = join(dir, FEATURE, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const SESSION_FIELDS = {
  item: 42,
  station: 4,
  role: 'builder',
  role_version: roleVersion('v1.0.0', ROLE_FILE),
  session: 'sess-1',
  model: 'sonnet',
};

const labelWrites = () =>
  calls().filter(
    (argv) =>
      (argv[0] === 'issue' && argv[1] === 'edit') ||
      (argv[0] === 'label' && argv[1] !== 'list') ||
      (argv[0] === 'api' && argv.some((a) => a.includes('/labels'))),
  );

describe('factory MCP server (contracts/mcp-tools.md)', () => {
  it('serves exactly advance_item, log_event and request_split, each with an input schema', async () => {
    const { client } = await connect(workingCopy());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['advance_item', 'log_event', 'request_split']);
    for (const tool of tools) expect(tool.inputSchema.type).toBe('object');
  });

  it('refuses every call when the launcher gave no session context, and writes nothing', async () => {
    github();
    const dir = workingCopy();
    const { call } = await connect(dir, { ...process.env, FACTORY_ROLE: undefined });
    const r = await call('log_event', { item: 42, kind: 'tool_call', tool: 'Bash' });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.value)).toMatch(/FACTORY_ROLE/);
    expect(events(dir)).toEqual([]);
  });
});

describe('advance_item (FR-022, FR-029b)', () => {
  it('writes an advance_request event and returns accepted with its request id, touching no label', async () => {
    github('building');
    const dir = workingCopy();
    const { call } = await connect(dir);

    const r = await call('advance_item', {
      item: 42,
      from_state: 'building',
      evidence: `${FEATURE}/tasks.md`,
    });

    expect(r).toEqual({
      isError: false,
      value: {
        accepted: true,
        request_id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/) as string,
      },
    });
    const { request_id } = r.value as { request_id: string };
    expect(events(dir)).toEqual([
      {
        ts: NOW.toISOString(),
        ...SESSION_FIELDS,
        kind: 'advance_request',
        tool: 'mcp__factory__advance_item',
        input_summary: JSON.stringify({
          request_id,
          from_state: 'building',
          to_state: 'verifying',
          evidence: `${FEATURE}/tasks.md`,
        }),
      },
    ]);
    expect(labelWrites()).toEqual([]);
  });

  it.each([
    ['line paused', 'building', ['pause:line']],
    ['station paused', 'building', ['pause:verify']],
    ['state mismatch', 'planned', []],
  ])('refuses with "%s" and writes no request', async (reason, state, inboxLabels) => {
    github(state, inboxLabels);
    const dir = workingCopy();
    const { call } = await connect(dir);

    const r = await call('advance_item', { item: 42, from_state: 'building', evidence: 'x' });

    expect(r).toEqual({ isError: false, value: { accepted: false, reason } });
    expect(events(dir)).toEqual([]);
    expect(labelWrites()).toEqual([]);
  });

  it('a pause on the station the item is already at does not stop the request to leave it', async () => {
    github('building', ['pause:build']);
    const { call } = await connect(workingCopy());
    const r = await call('advance_item', { item: 42, from_state: 'building', evidence: 'x' });
    expect(r.value).toMatchObject({ accepted: true });
  });

  it('refuses a state the session’s station does not work on, even when the item is in it', async () => {
    github('verifying');
    const { call } = await connect(workingCopy());
    const r = await call('advance_item', { item: 42, from_state: 'verifying', evidence: 'x' });
    expect(r.value).toEqual({ accepted: false, reason: 'state mismatch' });
  });
});

describe('log_event (AC-048)', () => {
  it('fills ts, role, session and model from the session and ignores the caller’s values', async () => {
    github();
    const dir = workingCopy();
    const { call } = await connect(dir);

    const r = await call('log_event', {
      item: 42,
      kind: 'gate_result',
      gate: 'coverage',
      pass: false,
      evidence: 'changed-line coverage 84%, token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      ts: '1999-01-01T00:00:00Z',
      role: 'reviewer',
      session: 'forged',
      model: 'claude-fable-5-1',
      station: 6,
      role_version: 'v9.9.9+000000000000',
    });

    expect(r).toEqual({ isError: false, value: { logged: true } });
    const [line] = events(dir);
    expect(line).toEqual({
      ts: NOW.toISOString(),
      ...SESSION_FIELDS,
      kind: 'gate_result',
      gate: 'coverage',
      pass: false,
      evidence: expect.stringMatching(/^changed-line coverage 84%, token /) as string,
    });
    expect(String(line?.evidence)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('logs usage telemetry', async () => {
    github();
    const dir = workingCopy();
    const { call } = await connect(dir);
    await call('log_event', { item: 42, kind: 'usage', usage: { sessions: 1, est_share: 0.25 } });
    expect(events(dir)).toEqual([
      {
        ts: NOW.toISOString(),
        ...SESSION_FIELDS,
        kind: 'usage',
        usage: { sessions: 1, est_share: 0.25 },
      },
    ]);
  });
});

describe('request_split (FR-024, AC-037, AC-057)', () => {
  it('logs a split event naming the task returned to Plan and tells the session to stop', async () => {
    github();
    const dir = workingCopy();
    const { call } = await connect(dir);

    const r = await call('request_split', {
      item: 42,
      task: 'T007',
      reason: 'size limit',
      notes: 'login and session store are separable',
    });

    expect(r.isError).toBe(false);
    expect(r.value).toEqual({
      split: true,
      task: 'T007',
      next: 'T007 is returned to Plan, which splits it into new work items; stop this session now.',
    });
    expect(events(dir)).toEqual([
      {
        ts: NOW.toISOString(),
        ...SESSION_FIELDS,
        kind: 'split',
        tool: 'mcp__factory__request_split',
        input_summary: JSON.stringify({
          task: 'T007',
          reason: 'size limit',
          notes: 'login and session store are separable',
        }),
      },
    ]);
  });
});

describe('invalid input: an MCP error and a blocked event (contracts/mcp-tools.md)', () => {
  it.each<[string, Record<string, unknown>, RegExp]>([
    ['advance_item', { item: 42, from_state: 'flying', evidence: 'x' }, /from_state/],
    ['advance_item', { item: 42, from_state: 'building' }, /evidence/],
    ['advance_item', { item: 43, from_state: 'building', evidence: 'x' }, /item 43/],
    ['advance_item', { item: 42, from_state: 'done', evidence: 'x' }, /from_state/],
    ['log_event', { item: 42, kind: 'approval' }, /kind/],
    ['log_event', { item: 42, kind: 'tool_call', gate: 'coverage' }, /gate/],
    ['log_event', { item: 42, kind: 'gate_result', gate: 'coverage' }, /pass/],
    ['log_event', { item: 42, kind: 'tool_call', colour: 'red' }, /colour/],
    ['request_split', { item: 42, task: 'T007', reason: 'bored' }, /reason/],
    ['request_split', { item: 42, task: 'build it all', reason: 'size limit' }, /task/],
    ['request_split', { item: '42', task: 'T007', reason: 'size limit' }, /item/],
  ])('%s %j', async (name, args, problem) => {
    github();
    const dir = workingCopy();
    const { client } = await connect(dir);

    await expect(client.callTool({ name, arguments: args })).rejects.toThrow(problem);

    const lines = events(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      ...SESSION_FIELDS,
      kind: 'blocked',
      tool: `mcp__factory__${name}`,
      input_summary: expect.stringMatching(problem) as string,
    });
  });

  it('an unknown tool is an MCP error', async () => {
    github();
    const { client } = await connect(workingCopy());
    await expect(client.callTool({ name: 'merge_pr', arguments: {} })).rejects.toThrow(/merge_pr/);
  });
});

describe('factory mcp', () => {
  it('refuses to serve without the session context the launcher sets', async () => {
    const err: string[] = [];
    const code = await runCli(['mcp'], {
      stdout: { write: () => undefined },
      stderr: { write: (s: string) => void err.push(s) },
      env: { PATH: process.env.PATH ?? '', FACTORY_STATION: '4' },
      stdinIsTTY: false,
      unreadAlerts: () => Promise.resolve([]),
      readStdin: () => Promise.reject(new Error('mcp reads stdin through its transport')),
    });
    expect(code).toBe(1);
    expect(err.join('')).toMatch(/FACTORY_ROLE and FACTORY_SESSION/);
  });
});
