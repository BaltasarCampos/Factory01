// Shared types from specs/001-software-factory/data-model.md.

/** `<tag>@<sha>`: a signed factory release tag and the commit it resolves to. */
export interface ReleasePin {
  tag: string;
  sha: string;
}

export type AgentsMode = 'cloud' | 'local';
export type Profile = 'typescript';

/** `.factory/config` after loading (src/model/config.ts fills defaults). */
export interface ProjectConfig {
  factory_release: ReleasePin;
  /** Adopted repos only: main's last unsigned commit. */
  baseline?: string;
  /** Required before any cloud session (AC-002). */
  agents?: AgentsMode;
  profile: Profile;
  /** `owner/name`; must be private. */
  repo: string;
  inbox_issue: number;
  parallel_sessions: number;
  retry_limit: number;
  size_limit_lines: number;
  coverage_min: number;
}

export const STATIONS = [
  'define',
  'intake',
  'specify',
  'plan',
  'build',
  'verify',
  'integrate',
  'release',
  'operate',
] as const;
export type StationName = (typeof STATIONS)[number];
/** Station number 0–8; `STATIONS[n]` is its name. */
export type Station = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const STATES = [
  'new',
  'triaged',
  'specified',
  'spec-approved',
  'planned',
  'building',
  'verifying',
  'integrating',
  'releasing',
  'done',
  'blocked',
  'escalated',
] as const;
export type State = (typeof STATES)[number];

export const ROLES = [
  'define',
  'intake',
  'spec',
  'planner',
  'builder',
  'test',
  'reviewer',
  'security',
  'integrator',
  'release',
  'ops',
  'coach',
] as const;
export type RoleName = (typeof ROLES)[number];

export const ITEM_TYPES = ['feature', 'bug', 'debt', 'security', 'dependency', 'copy'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
export type Priority = 'p0' | 'p1' | 'p2' | 'p3';
export type Tier = 1 | 2 | 3;

export type OwnerGateLabel = 'owner:approved' | 'owner:spec-approved' | 'owner:waiver';
export type StateLabel = `state:${State}`;
export type TierLabel = `tier:${Tier}`;
export type PauseLabel = 'pause:line' | `pause:${StationName}`;
export type Label = OwnerGateLabel | StateLabel | TierLabel | PauseLabel;

export interface WorkItem {
  issue: number;
  slug: string;
  branch: string;
  feature_dir: string;
  type?: ItemType;
  priority?: Priority;
  tier?: Tier;
  state: State;
  owner_labels: OwnerGateLabel[];
  attempts: Partial<Record<Station, number>>;
  pr?: number;
  author: string;
}

export type EventKind =
  | 'tool_call'
  | 'blocked'
  | 'gate_result'
  | 'approval'
  | 'alert'
  | 'usage'
  | 'split'
  | 'advance_request'
  | 'owner_comment'
  | 'cap';

/** One line of `events.jsonl`. Untrusted telemetry: never a merge or gate decision input. */
export interface Event {
  ts: string;
  item: number;
  station: Station;
  role: RoleName;
  role_version: string;
  session: string;
  model: string;
  kind: EventKind;
  tool?: string;
  input_summary?: string;
  gate?: string;
  pass?: boolean;
  evidence?: string;
  usage?: { sessions: number; est_share: number };
}

export type ApprovalGate = 'approved' | 'spec-approved' | 'waiver' | 'resume' | 'deployed';

/** Fields of a `factory-approve/v1` record, in canonical order. */
export interface ApprovalRecord {
  repo: string;
  issue: number;
  gate: ApprovalGate;
  tier?: Tier;
  branch?: string;
  spec_sha?: string;
  scope?: 'line' | StationName;
  waives?: string;
  head?: string;
  timestamp: string;
  nonce: string;
}

/** `specs/<feature>/.station.json`, written by the dispatcher before each session. */
export interface StationManifest {
  item: number;
  station: Station;
  role: RoleName;
  branch: string;
  task?: string;
  files?: string[];
  issued_at: string;
}

/** `guardrails.manifest.json` of a factory release. */
export interface GuardrailManifest {
  release: string;
  commit: string;
  /** Path → SHA-256 hex. */
  files: Record<string, string>;
}

export type PrKind = 'item' | 'define' | 'upgrade' | 'factory-log' | 'factory-repo';

/** One unread entry of the Owner inbox issue. */
export interface Alert {
  id: string;
  urgency: 'urgent' | 'info';
  kind: string;
  text: string;
  url?: string;
}
