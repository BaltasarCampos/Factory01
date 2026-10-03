// Canonical `factory-approve/v1` records and their issue-comment envelope
// (data-model.md § Approval record, contracts/approval-record.md steps 1–2).
//
// The signature covers the exact bytes, so there is one serialisation: fields in a fixed order,
// LF endings, `key: value` with one space, absent fields omitted. `parse` accepts only those
// bytes; anything else is rejected rather than normalised.
import { randomBytes } from 'node:crypto';
import { isSlug } from '../model/naming.js';
import { STATIONS, type ApprovalGate, type ApprovalRecord, type Tier } from '../model/types.js';

export const RECORD_HEADER = 'factory-approve/v1';
export const RECORD_MARKER = '<!-- factory-record v1 -->';

export const FIELD_ORDER = [
  'repo',
  'issue',
  'gate',
  'tier',
  'branch',
  'spec_sha',
  'scope',
  'waives',
  'head',
  'timestamp',
  'nonce',
] as const satisfies readonly (keyof ApprovalRecord)[];
type Field = (typeof FIELD_ORDER)[number];
type Fields = Map<Field, string>;

export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordError';
  }
}

/** A record's canonical bytes and the armored SSH signature over them. */
export interface SignedText {
  text: string;
  signature: string;
}

const GATES: readonly string[] = [
  'approved',
  'spec-approved',
  'waiver',
  'resume',
  'deployed',
] satisfies ApprovalGate[];
const SCOPES: readonly string[] = ['line', ...STATIONS];

// Same rule as `repo` in .factory/config.
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const POSITIVE_INT = /^[1-9]\d*$/;
const SHA = /^[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{32}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const BRANCH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const SIGNATURE =
  /^-----BEGIN SSH SIGNATURE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END SSH SIGNATURE-----\n$/;

/** Waiver targets, one pattern per row of data-model.md § Waiver targets. */
const WAIVES = [
  /^gate:[a-z0-9]+(?:-[a-z0-9]+)*$/,
  /^check:guardrail-change@v\d+\.\d+\.\d+@[0-9a-f]{40}$/,
  /^dep:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@[0-9A-Za-z][0-9A-Za-z.+-]*$/,
  /^finding:[^\s@]+@[^\s@:]+:[1-9]\d*$/,
];
/** Gates checked against code: their waivers carry the PR head they cover (AC-089). */
const CODE_GATE = /^(?:red-green|coverage|size|ac-\d{3,}|ci-[a-z0-9]+(?:-[a-z0-9]+)*)$/;

export function isCodeGateWaiver(waives: string): boolean {
  return waives.startsWith('gate:') && CODE_GATE.test(waives.slice('gate:'.length));
}

type Presence = 'required' | 'optional';
type GatedField = 'tier' | 'branch' | 'spec_sha' | 'scope' | 'waives' | 'head';
const GATED: readonly GatedField[] = ['tier', 'branch', 'spec_sha', 'scope', 'waives', 'head'];

/** Gate-specific fields; any field not listed for a gate is not allowed. */
const PRESENCE: Record<ApprovalGate, Partial<Record<GatedField, Presence>>> = {
  approved: { tier: 'required', branch: 'required' },
  'spec-approved': { tier: 'required', branch: 'required', spec_sha: 'required' },
  // Refined below by waiver target: gate: needs tier + item branch; head only for code gates.
  waiver: { tier: 'optional', branch: 'optional', waives: 'required', head: 'optional' },
  resume: { scope: 'required' },
  deployed: { head: 'required' },
};

const FORMAT: Record<Field, { test: (v: string) => boolean; rule: string }> = {
  repo: { test: (v) => REPO.test(v), rule: 'must be owner/name' },
  issue: { test: (v) => POSITIVE_INT.test(v), rule: 'must be a positive integer' },
  gate: { test: (v) => GATES.includes(v), rule: `must be one of ${GATES.join(', ')}` },
  tier: { test: (v) => /^[123]$/.test(v), rule: 'must be 1, 2 or 3' },
  branch: { test: (v) => BRANCH.test(v) && !v.includes('..'), rule: 'must be a branch name' },
  spec_sha: { test: (v) => SHA.test(v), rule: 'must be a 40-hex blob sha' },
  scope: { test: (v) => SCOPES.includes(v), rule: 'must be line or a station name' },
  waives: { test: (v) => WAIVES.some((p) => p.test(v)), rule: 'must be a waiver target' },
  head: { test: (v) => SHA.test(v), rule: 'must be a 40-hex commit' },
  timestamp: { test: isTimestamp, rule: 'must be RFC 3339 UTC, YYYY-MM-DDTHH:MM:SSZ' },
  nonce: { test: (v) => NONCE.test(v), rule: 'must be 32 lowercase hex chars' },
};

function isTimestamp(value: string): boolean {
  if (!TIMESTAMP.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && recordTimestamp(date) === value;
}

function isItemBranch(branch: string, issue: string): boolean {
  const prefix = `claude/${issue}-`;
  return branch.startsWith(prefix) && isSlug(branch.slice(prefix.length));
}

/** Every rule broken by a set of fields, `<field>: <why>`; empty when valid. */
function problemsOf(fields: Fields): string[] {
  const problems: string[] = [];
  const valid = (field: Field): string | undefined => {
    const value = fields.get(field);
    return value !== undefined && FORMAT[field].test(value) ? value : undefined;
  };

  for (const [field, value] of fields) {
    if (value === '') problems.push(`${field}: absent fields are omitted, not empty`);
    else if (!FORMAT[field].test(value)) problems.push(`${field}: ${FORMAT[field].rule}`);
  }
  for (const field of ['repo', 'issue', 'gate', 'timestamp', 'nonce'] as const) {
    if (!fields.has(field)) problems.push(`${field}: required`);
  }

  const gate = valid('gate') as ApprovalGate | undefined;
  if (gate === undefined) return problems;
  const presence = { ...PRESENCE[gate] };
  const waives = valid('waives');
  if (gate === 'waiver' && waives !== undefined) {
    if (isCodeGateWaiver(waives)) presence.head = 'required';
    else delete presence.head;
    if (waives.startsWith('gate:')) presence.tier = presence.branch = 'required';
  }
  for (const field of GATED) {
    const has = fields.has(field);
    if (presence[field] === 'required' && !has) problems.push(`${field}: required for ${gate}`);
    if (presence[field] === undefined && has) problems.push(`${field}: not allowed for ${gate}`);
  }

  // Records for a work item name the item's own branch, so they bind to that issue only.
  const issue = valid('issue');
  const branch = valid('branch');
  const forItem = gate === 'approved' || gate === 'spec-approved' || waives?.startsWith('gate:');
  if (
    forItem === true &&
    issue !== undefined &&
    branch !== undefined &&
    !isItemBranch(branch, issue)
  )
    problems.push(`branch: must be claude/${issue}-<slug> for issue ${issue}`);
  return problems;
}

function fieldsOf(record: ApprovalRecord): Fields {
  const fields: Fields = new Map();
  for (const field of FIELD_ORDER) {
    const value: string | number | undefined = record[field];
    if (value !== undefined) fields.set(field, String(value));
  }
  return fields;
}

function toText(fields: Fields): string {
  let text = `${RECORD_HEADER}\n`;
  for (const field of FIELD_ORDER) {
    const value = fields.get(field);
    if (value !== undefined) text += `${field}: ${value}\n`;
  }
  return text;
}

function check(fields: Fields): void {
  const problems = problemsOf(fields);
  if (problems.length > 0) throw new RecordError(problems.join('; '));
}

/** The canonical bytes of a valid record; throws RecordError when any rule is broken. */
export function serialise(record: ApprovalRecord): string {
  const fields = fieldsOf(record);
  check(fields);
  return toText(fields);
}

/** Parse canonical record bytes; anything not byte-identical to `serialise` is rejected. */
export function parse(text: string): ApprovalRecord {
  const lines = text.split('\n');
  if (lines.pop() !== '') throw new RecordError('record must end with a newline');
  if (lines.shift() !== RECORD_HEADER)
    throw new RecordError(`record must start with ${RECORD_HEADER}`);

  const fields: Fields = new Map();
  for (const line of lines) {
    const m = /^([a-z_]+): (.*)$/.exec(line);
    const field = m?.[1] as Field | undefined;
    if (m?.[2] === undefined || field === undefined)
      throw new RecordError(`malformed line: ${JSON.stringify(line)}`);
    if (!(FIELD_ORDER as readonly string[]).includes(field))
      throw new RecordError(`unknown field: ${field}`);
    if (fields.has(field)) throw new RecordError(`duplicate field: ${field}`);
    fields.set(field, m[2]);
  }
  check(fields);
  if (toText(fields) !== text) throw new RecordError('record is not in canonical form');

  const get = (field: Field) => fields.get(field);
  const record: ApprovalRecord = {
    repo: get('repo') ?? '',
    issue: Number(get('issue')),
    gate: get('gate') as ApprovalGate,
    timestamp: get('timestamp') ?? '',
    nonce: get('nonce') ?? '',
  };
  const tier = get('tier');
  if (tier !== undefined) record.tier = Number(tier) as Tier;
  for (const field of ['branch', 'spec_sha', 'waives', 'head'] as const) {
    const value = get(field);
    if (value !== undefined) record[field] = value;
  }
  const scope = get('scope');
  if (scope !== undefined) record.scope = scope as NonNullable<ApprovalRecord['scope']>;
  return record;
}

/** 128 random bits as 32 lowercase hex chars. */
export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

/** RFC 3339 UTC to the second, the only form a record accepts. */
export function recordTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The issue-comment body that posts a signed record (contracts/approval-record.md). */
export function renderComment(record: ApprovalRecord, signed: SignedText): string {
  const detail = record.waives ?? record.scope ?? record.head;
  const tier = record.tier === undefined ? '' : ` (tier ${String(record.tier)})`;
  const what = `${record.gate}${detail === undefined ? '' : ` ${detail}`} for #${String(record.issue)}`;
  return [
    RECORD_MARKER,
    `**Owner approval**: ${what}${tier}`,
    '',
    `\`\`\`factory-record\n${signed.text}\`\`\``,
    '',
    `\`\`\`factory-signature\n${signed.signature}\`\`\``,
    '',
  ].join('\n');
}

/** The single fenced block with this info string, each line LF-terminated. */
function block(body: string, info: string): string {
  const lines = body.split('\n');
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== `\`\`\`${info}`) continue;
    const end = lines.indexOf('```', i + 1);
    if (end === -1) throw new RecordError(`unterminated ${info} block`);
    found.push(
      lines
        .slice(i + 1, end)
        .map((l) => `${l}\n`)
        .join(''),
    );
    i = end;
  }
  const [only, ...more] = found;
  if (only === undefined) throw new RecordError(`no ${info} block`);
  if (more.length > 0) throw new RecordError(`more than one ${info} block`);
  return only;
}

/**
 * Step 1 of verification: the record and signature blocks of a comment, exactly as posted.
 * The record bytes still need `parse` (step 2) and a signature check.
 */
export function extractFromComment(body: string): SignedText {
  const text = block(body, 'factory-record');
  const signature = block(body, 'factory-signature');
  if (!SIGNATURE.test(signature))
    throw new RecordError('factory-signature is not an SSH signature');
  return { text, signature };
}
