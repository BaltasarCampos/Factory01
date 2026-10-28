// `factory hook log` (PostToolUse, all tools): one Event per tool call (FR-021, AC-048), to the
// session's own log, its facts from the session's record (src/hooks/session.ts), never from the
// clone's `.station.json`, config or role files, nor the hook input's `agent_type`. A missing or
// malformed record is an error, and the caller blocks.
import { homedir } from 'node:os';
import { appendEvent } from '../events/append.js';
import { readSessionRecord, recordEvent, sessionEvents, sessionId } from './session.js';

export interface HookContext {
  /** The session's working copy. */
  cwd: string;
  now: () => Date;
  /** The session's environment, whose `HOME` holds the session's record. */
  env?: NodeJS.ProcessEnv;
}

export interface HookResult {
  block: boolean;
  /** Shown to the session when blocking. */
  reason?: string;
}

export type HookInput = Record<string, unknown>;

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
  const home = ctx.env?.HOME ?? homedir();
  const session = sessionId(input.session_id);
  const record = readSessionRecord(home, session);
  const tool = typeof input.tool_name === 'string' ? input.tool_name : 'unknown';
  const fields = { kind: 'tool_call', tool, input_summary: summarise(input.tool_input) } as const;
  await appendEvent(sessionEvents(home, session), recordEvent(record, session, fields), ctx.now);
  return { block: false };
}
