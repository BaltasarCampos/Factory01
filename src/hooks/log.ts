// `factory hook log` (PostToolUse, all tools): one Event per tool call (FR-021, AC-048), plus
// the session facts every hook needs. The role comes from the hook input's agent field (R5);
// an item role's item, station and log come from the dispatcher-written `.station.json`, which
// no role may edit. Anything that cannot be determined is an error, and the caller blocks.
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { appendEvent, type EventInput, type LogTarget } from '../events/append.js';
import { roleVersion } from '../events/schema.js';
import { loadConfig } from '../model/config.js';
import { ROLES, type RoleName, type Station } from '../model/types.js';

export interface HookContext {
  /** The session's working copy. */
  cwd: string;
  now: () => Date;
  /** The session's environment: `FACTORY_ITEM` and `FACTORY_STATION`, set by the launcher. */
  env?: NodeJS.ProcessEnv;
}

export interface HookResult {
  block: boolean;
  /** Shown to the session when blocking. */
  reason?: string;
}

export type HookInput = Record<string, unknown>;

export class HookError extends Error {
  override name = 'HookError';
}

/** Hook-input field naming the agent (role); Phase 0 probe T125 confirms it (research R5). */
export const AGENT_FIELD = 'agent_type';

/**
 * Roles on a fixed branch (data-model.md § Role) and their station. Their events go to
 * `claude/factory-log` unless `noLog` says why they have no log through this hook.
 */
const FIXED_ROLES: Partial<Record<RoleName, { station: Station; noLog?: string }>> = {
  define: { station: 0, noLog: 'define has no event log target in this build (Define, slice 12)' },
  intake: { station: 1, noLog: 'intake logs to issue comments, not through this hook' },
  release: { station: 7 },
  ops: { station: 8 },
  // The Coach learns from Operate's data; it has no station of its own.
  coach: { station: 8 },
};

export interface Session {
  role: RoleName;
  station: Station;
  /** Issue number; 0 for project-level work. */
  item: number;
  session: string;
  model: string;
  roleVersion: string;
  /** Where this session's events go; a string explains why there is none. */
  log: LogTarget | string;
}

function readJson(path: string, what: string): Record<string, unknown> {
  if (!existsSync(path)) throw new HookError(`${what} not found at ${path}`);
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HookError(`${what} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** The current item's station manifest: item, station and feature folder. */
function stationManifest(cwd: string, role: RoleName) {
  const feature = readJson(join(cwd, '.specify', 'feature.json'), '.specify/feature.json');
  const dir = feature.feature_directory;
  if (typeof dir !== 'string' || !/^specs\/[^/]+$/.test(normalize(dir))) {
    throw new HookError(`.specify/feature.json: feature_directory must be specs/<feature>`);
  }
  const manifest = readJson(join(cwd, dir, '.station.json'), `${dir}/.station.json`);
  const { item, station } = manifest;
  if (manifest.role !== role) {
    throw new HookError(
      `${dir}/.station.json is for role ${JSON.stringify(manifest.role)}, not ${role}`,
    );
  }
  if (!Number.isSafeInteger(item) || (item as number) < 1) {
    throw new HookError(`${dir}/.station.json: item must be an issue number`);
  }
  if (!Number.isSafeInteger(station) || (station as number) < 0 || (station as number) > 8) {
    throw new HookError(`${dir}/.station.json: station must be 0–8`);
  }
  return { item: item as number, station: station as Station, featureDir: join(cwd, dir) };
}

/** The role file's `model:` and its version (release tag + file hash). */
async function roleIdentity(cwd: string, role: RoleName) {
  const config = await loadConfig(join(cwd, '.factory', 'config'));
  const path = join(cwd, '.claude', 'agents', `${role}.md`);
  if (!existsSync(path)) throw new HookError(`role file .claude/agents/${role}.md not found`);
  const text = readFileSync(path);
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text.toString('utf8'));
  const model = (parseYaml(front?.[1] ?? '') as { model?: unknown } | null)?.model;
  if (typeof model !== 'string' || model === '') {
    throw new HookError(`.claude/agents/${role}.md has no model in its frontmatter`);
  }
  return { model, roleVersion: roleVersion(config.factory_release.tag, text) };
}

/**
 * The item a fixed-branch session works on, from the launcher's `FACTORY_ITEM` (such roles have
 * no `.station.json`); 0 without one. The launcher always sets `FACTORY_STATION`, which must be
 * the role's station, and sets no item for Define, which works for the project.
 */
function launchedItem(env: NodeJS.ProcessEnv, station: Station): number {
  const { FACTORY_ITEM: item, FACTORY_STATION: at } = env;
  if (at !== undefined && at !== String(station))
    throw new HookError(`FACTORY_STATION ${at} is not this role's station ${String(station)}`);
  if (item === undefined) return 0;
  if (station === 0) throw new HookError('Define works for the project: FACTORY_ITEM is set');
  if (!/^[1-9]\d*$/.test(item)) throw new HookError(`FACTORY_ITEM ${item} is not an issue number`);
  return Number(item);
}

export async function resolveSession(input: HookInput, ctx: HookContext): Promise<Session> {
  const agent = input[AGENT_FIELD];
  const role = ROLES.find((r) => r === agent);
  if (role === undefined) {
    throw new HookError(`cannot determine the role (hook input ${AGENT_FIELD}: ${String(agent)})`);
  }
  const session = input.session_id;
  if (typeof session !== 'string' || session === '')
    throw new HookError('hook input has no session_id');
  const identity = await roleIdentity(ctx.cwd, role);
  const fixed = FIXED_ROLES[role];
  if (fixed !== undefined) {
    const log = fixed.noLog ?? { factoryLog: ctx.cwd };
    const item = launchedItem(ctx.env ?? {}, fixed.station);
    return { role, station: fixed.station, item, session, ...identity, log };
  }
  const { item, station, featureDir } = stationManifest(ctx.cwd, role);
  return { role, station, item, session, ...identity, log: { featureDir } };
}

export function eventInput(s: Session, fields: Pick<EventInput, 'kind'> & Partial<EventInput>) {
  return {
    item: s.item,
    station: s.station,
    role: s.role,
    role_version: s.roleVersion,
    session: s.session,
    model: s.model,
    ...fields,
  } satisfies EventInput;
}

const SUMMARY_MAX = 500;

/** What a tool call was about: the command or path, never file content. */
export function summarise(toolInput: unknown): string {
  const t = (typeof toolInput === 'object' && toolInput !== null ? toolInput : {}) as Record<
    string,
    unknown
  >;
  const pick = [t.command, t.file_path, t.path, t.pattern, t.url].find(
    (v): v is string => typeof v === 'string',
  );
  const text = pick ?? JSON.stringify(t);
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text;
}

export async function runLog(input: HookInput, ctx: HookContext): Promise<HookResult> {
  const s = await resolveSession(input, ctx);
  if (typeof s.log === 'string') throw new HookError(s.log);
  const tool = typeof input.tool_name === 'string' ? input.tool_name : 'unknown';
  const fields = { kind: 'tool_call', tool, input_summary: summarise(input.tool_input) } as const;
  await appendEvent(s.log, eventInput(s, fields), ctx.now);
  return { block: false };
}
