// The label set every project gets (data-model.md § Label kinds). `owner:` labels only mark where
// a signed record is; gates are decided by the records (contracts/approval-record.md).
import { ensureLabels, type LabelSpec } from '../github/labels.js';
import type { GhOptions } from '../github/gh.js';
import { ITEM_TYPES, STATES, STATIONS } from '../model/types.js';

const OWNER = 'b60205';
const STATE = '0e8a16';
const TIER = '1d76db';
const PAUSE = 'fbca04';
const TRIAGE = 'c5def5';

export const FACTORY_LABELS: readonly LabelSpec[] = [
  { name: 'owner:approved', color: OWNER, description: 'Owner approval (needs a signed record)' },
  { name: 'owner:spec-approved', color: OWNER, description: 'Owner spec approval (signed)' },
  { name: 'owner:waiver', color: OWNER, description: 'Owner waiver (signed)' },
  ...STATES.map((s) => ({ name: `state:${s}`, color: STATE, description: `Line state: ${s}` })),
  ...([1, 2, 3] as const).map((t) => ({
    name: `tier:${String(t)}`,
    color: TIER,
    description: `Risk tier ${String(t)}`,
  })),
  { name: 'pause:line', color: PAUSE, description: 'Whole line paused; factory resume lifts it' },
  ...STATIONS.map((s) => ({
    name: `pause:${s}`,
    color: PAUSE,
    description: `Station ${s} paused; factory resume ${s} lifts it`,
  })),
  { name: 'security', color: OWNER, description: 'Security finding' },
  // Set by Intake (AC-009); not gates, so no record backs them.
  ...ITEM_TYPES.map((t) => ({ name: `type:${t}`, color: TRIAGE, description: `Item type: ${t}` })),
  ...(['p0', 'p1', 'p2', 'p3'] as const).map((p) => ({
    name: `priority:${p}`,
    color: TRIAGE,
    description: `Priority ${p}`,
  })),
];

/** Create the factory labels the repository lacks; returns the created names. */
export function installLabels(repo: string, options: GhOptions = {}): Promise<string[]> {
  return ensureLabels(repo, FACTORY_LABELS, options);
}
