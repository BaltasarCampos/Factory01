// Event schema (data-model.md § Event). Events are untrusted telemetry: they feed metrics, the
// Coach and escalation timing, never a merge, deploy or gate decision (FR-028).
import { createHash } from 'node:crypto';
import { ROLES, type Event, type EventKind } from '../model/types.js';

export const EVENT_KINDS: readonly EventKind[] = [
  'tool_call',
  'blocked',
  'gate_result',
  'approval',
  'alert',
  'usage',
  'split',
  'advance_request',
  'owner_comment',
  'cap',
];

export class EventError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`invalid event:\n  ${problems.join('\n  ')}`);
    this.name = 'EventError';
    this.problems = problems;
  }
}

const RFC3339 = /^\d{4}-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ROLE_VERSION = /^v\d+\.\d+\.\d+\+[0-9a-f]{12}$/;
const FIELDS = new Set([
  'ts',
  'item',
  'station',
  'role',
  'role_version',
  'session',
  'model',
  'kind',
  'tool',
  'input_summary',
  'gate',
  'pass',
  'evidence',
  'usage',
]);

/** `<release tag>+<first 12 hex of the role file's SHA-256>`. */
export function roleVersion(releaseTag: string, roleFile: string | Buffer): string {
  return `${releaseTag}+${createHash('sha256').update(roleFile).digest('hex').slice(0, 12)}`;
}

const isInt = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): boolean =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const isText = (v: unknown): boolean => typeof v === 'string' && v !== '';

/** The event, or EventError listing every problem. */
export function validateEvent(value: unknown): Event {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EventError(['event is not an object']);
  }
  const e = value as Record<string, unknown>;
  const problems: string[] = [];
  const check = (ok: boolean, field: string, rule: string) => {
    if (!ok) problems.push(`${field}: ${rule}`);
  };

  for (const key of Object.keys(e)) check(FIELDS.has(key), key, 'unknown field');
  const ts = e.ts;
  check(
    typeof ts === 'string' && RFC3339.test(ts) && !Number.isNaN(Date.parse(ts)),
    'ts',
    'RFC 3339 time required',
  );
  check(isInt(e.item, 0), 'item', 'issue number required (0 for project-level work)');
  check(isInt(e.station, 0, 8), 'station', 'integer 0–8 required');
  check((ROLES as readonly unknown[]).includes(e.role), 'role', 'one of the 12 roles required');
  check(
    typeof e.role_version === 'string' && ROLE_VERSION.test(e.role_version),
    'role_version',
    'release tag + role file hash required',
  );
  check(isText(e.session), 'session', 'session id required');
  check(isText(e.model), 'model', 'model required');
  check(!(typeof e.model === 'string' && /fable/i.test(e.model)), 'model', 'must not be Fable');
  check((EVENT_KINDS as readonly unknown[]).includes(e.kind), 'kind', 'unknown kind');
  for (const field of ['tool', 'input_summary', 'evidence'] as const) {
    check(e[field] === undefined || typeof e[field] === 'string', field, 'string expected');
  }

  const gateResult = e.kind === 'gate_result';
  check(gateResult ? isText(e.gate) : e.gate === undefined, 'gate', 'gate_result only, required');
  check(
    gateResult ? typeof e.pass === 'boolean' : e.pass === undefined,
    'pass',
    'gate_result only, boolean required',
  );
  check(gateResult || e.evidence === undefined, 'evidence', 'gate_result only');

  const usage = e.usage as Record<string, unknown> | null | undefined;
  const usageOk =
    typeof usage === 'object' &&
    usage !== null &&
    isInt(usage.sessions, 0) &&
    typeof usage.est_share === 'number' &&
    usage.est_share >= 0 &&
    usage.est_share <= 1 &&
    Object.keys(usage).every((k) => k === 'sessions' || k === 'est_share');
  check(
    e.kind === 'usage' ? usageOk : usage === undefined || usageOk,
    'usage',
    '{ sessions, est_share 0–1 } required for usage events',
  );

  if (problems.length > 0) throw new EventError(problems);
  return e as unknown as Event;
}
