// One dispatcher pass (contracts/cli.md `factory dispatch`, FR-016f): read the config on main,
// check the two copies of the Owner key, derive pause state, admit issues, verify every
// `owner:` label, apply each item's transition through `state:` labels, and start at most one
// session.
//
// The dispatcher is itself an agent session with a shell, so its decisions are advisory
// (data-model.md § State machine): only signed records, signed commits and the laptop's checks
// decide what reaches main. Station evidence (T060) and the signed-history audit (T139) are
// supplied by the caller. Nothing is admitted before main has the Owner-signed Define merge, and
// when main's key lists or `git verify-commit` cannot be read or run the pass admits nothing,
// moves nothing and alerts the Owner.
import { checkSecondCopy, type KeyCheck, type ReleaseKeys } from '../approvals/keys.js';
import { verifyGate, type PostedComment, type Verdict } from '../approvals/verify.js';
import { RefusedError } from '../cli/env.js';
import { briefMerged, verifiedMerges } from '../git/merges.js';
import { listComments } from '../github/comments.js';
import type { GhOptions } from '../github/gh.js';
import { addLabel, removeLabel } from '../github/labels.js';
import { timeline } from '../github/timeline.js';
import { configOnMain } from '../model/config.js';
import {
  STATES,
  STATIONS,
  type AgentsMode,
  type Event,
  type ProjectConfig,
  type ReleasePin,
  type RoleName,
  type State,
  type Station,
  type Tier,
} from '../model/types.js';
import { alert, parseAlert, type InboxTarget, type NewAlert } from '../notify/inbox.js';
import { derivePause, resumeEntries, type LabelEvent } from '../pause/derive.js';
import { listOpenIssues, notAdmitted, type IssueSummary } from './admission.js';
import { selectLauncher } from './launcher/select.js';
import type { Launchers } from './launcher/types.js';
import {
  nextTransition,
  ownerBasisMissing,
  STATION_OF,
  type Evidence,
  type ItemStatus,
  type OwnerGate,
} from './transitions.js';

/** What the caller found on the item branch, CI and main (T060). */
export type StationEvidence = Omit<Evidence, 'owner' | 'rotationPending' | 'historySigned'> & {
  /** Current `spec.md` blob on the item branch, which `owner:spec-approved` must match. */
  specSha?: string;
  /** The station working on the item's state has work left and no session running. */
  needsSession?: boolean;
};

export interface Candidate {
  issue: IssueSummary;
  state: State;
  /** The branch named by the verified `owner:approved` record. */
  branch?: string;
}

export type DispatchEvent = Pick<Event, 'kind' | 'station' | 'gate' | 'pass' | 'evidence'>;

export interface DispatchContext {
  /** A clone of the project; the caller fetches `mainRef` first. */
  projectDir: string;
  /** Default `origin/main`. */
  mainRef?: string;
  /** Key lists of the release pinned on main (src/approvals/keys.ts `releaseKeys`). */
  keysFor: (pin: ReleasePin) => ReleaseKeys;
  secondCopy: string | undefined;
  previousNewest?: string;
  historySigned: (config: ProjectConfig) => Promise<boolean>;
  gatherEvidence: (item: Candidate, config: ProjectConfig) => Promise<StationEvidence>;
  launchers: Launchers;
  /** Records an event for the item; where it is written is the caller's choice. */
  logEvent: (issue: number, event: DispatchEvent) => Promise<void>;
  gh?: GhOptions;
}

export interface Move {
  issue: number;
  from: State;
  to: State;
  reason: string;
}

export interface PassResult {
  /** Why the pass stopped before looking at any item. */
  halted?: string;
  moves: Move[];
  /** Issues not admitted to the line. */
  skipped: { issue: number; reason: string }[];
  launched?: {
    issue: number;
    station: Station;
    role: RoleName;
    branch: string;
    mode: AgentsMode;
    sessionId: string;
  };
  /** Why a ready session was not started. */
  refused?: string;
}

/** The station whose session works on an item in each state; other states wait. */
const WORK_STATION: Partial<Record<State, Station>> = {
  new: 1,
  triaged: 2,
  'spec-approved': 3,
  building: 4,
  verifying: 5,
  integrating: 6,
  releasing: 7,
};
/** The role a station's session runs as (Verify's Reviewer and Security sessions come later). */
const ROLE_AT: Readonly<Record<Station, RoleName>> = {
  0: 'define',
  1: 'intake',
  2: 'spec',
  3: 'planner',
  4: 'builder',
  5: 'test',
  6: 'integrator',
  7: 'release',
  8: 'ops',
};
const GATES: readonly OwnerGate[] = ['approved', 'spec-approved', 'waiver'];
const FINAL: readonly State[] = ['done', 'escalated'];

/** The item's state: its newest current `state:` label, `new` without one. */
export function itemStatus(labels: readonly string[], events: readonly LabelEvent[]): ItemStatus {
  const adds = events.filter((e) => e.event === 'labeled' && e.label.startsWith('state:'));
  const lastAdd = (label: string) => adds.findLastIndex((e) => e.label === label);
  const current = labels
    .filter((l) => l.startsWith('state:'))
    .filter((l) => (STATES as readonly string[]).includes(l.slice('state:'.length)))
    .sort((a, b) => lastAdd(a) - lastAdd(b));
  const state = (current.at(-1)?.slice('state:'.length) ?? 'new') as State;
  if (state !== 'blocked') return { state };
  const blockedAt = lastAdd('state:blocked');
  const before = adds.slice(0, Math.max(blockedAt, 0)).filter((e) => e.label !== 'state:blocked');
  const from = before.at(-1)?.label.slice('state:'.length) as State | undefined;
  return from === undefined ? { state } : { state, blockedFrom: from };
}

const isForged = (v: Verdict) => !v.ok && (v.kind === 'tampering' || v.kind === 'replay');

export async function dispatchOnce(ctx: DispatchContext): Promise<PassResult> {
  const result: PassResult = { moves: [], skipped: [] };
  const options = ctx.gh ?? {};
  const config = configOnMain(ctx.projectDir, ctx.mainRef);
  const { repo } = config;
  const inbox: InboxTarget = { ...options, repo, inboxIssue: config.inbox_issue };

  const inboxComments = await listComments(repo, config.inbox_issue, options);
  const posted = inboxComments.map(parseAlert).filter((a) => a !== undefined);
  /** One inbox alert per kind and text, however many passes see the same problem. */
  const alertOnce = async (input: NewAlert) => {
    if (posted.some((a) => a.kind === input.kind && a.text === input.text)) return;
    await alert(inbox, input);
    posted.push({ id: '', urgency: input.urgency, kind: input.kind, text: input.text });
  };

  let keys: ReleaseKeys;
  let keyCheck: KeyCheck;
  let brief: boolean;
  try {
    keys = ctx.keysFor(config.factory_release);
    keyCheck = checkSecondCopy(keys, ctx.secondCopy, ctx.previousNewest);
    const history = verifiedMerges(ctx.projectDir, keys, {
      ref: ctx.mainRef ?? 'origin/main',
      baseline: config.baseline,
    });
    brief = briefMerged(history);
  } catch (err) {
    const reason = `cannot verify main, so nothing is admitted: ${err instanceof Error ? err.message : String(err)}`;
    await alertOnce({ urgency: 'urgent', kind: 'unverifiable', text: `line stopped: ${reason}` });
    return { ...result, halted: reason };
  }
  if (keyCheck.status !== 'ok') {
    const kind = keyCheck.status === 'rotation-pending' ? 'rotation-pending' : 'tampering';
    await alertOnce({ urgency: 'urgent', kind, text: `line stopped: ${keyCheck.reason}` });
    return { ...result, halted: keyCheck.reason };
  }
  const resumes = resumeEntries(inboxComments, {
    keys,
    secondCopy: ctx.secondCopy,
    ...(ctx.previousNewest === undefined ? {} : { previousNewest: ctx.previousNewest }),
    repo,
    inboxIssue: config.inbox_issue,
  });
  const pause = derivePause(await timeline(repo, config.inbox_issue, options), resumes);
  if (!(await ctx.historySigned(config)))
    return { ...result, halted: 'main has a first-parent commit not signed by the Owner' };
  if (pause.line) return { ...result, halted: 'pause:line in effect' };

  let target: { item: Candidate; station: Station; branch: string } | undefined;
  for (const issue of await listOpenIssues(repo, options)) {
    if (issue.number === config.inbox_issue) continue;
    const comments: PostedComment[] = await listComments(repo, issue.number, options);
    const events = await timeline(repo, issue.number, options);
    const labelAdds = events.filter((e) => e.event === 'labeled');
    const verdict = (gate: OwnerGate, specSha?: string): Verdict => {
      const label = `owner:${gate}`;
      if (!labelAdds.some((a) => a.label === label))
        return { ok: false, kind: 'missing', reason: `no ${label} label` };
      const expected = { repo, issue: issue.number, gate, ...(specSha ? { specSha } : {}) };
      const check = { keys, secondCopy: ctx.secondCopy, expected, comments, labelAdds };
      try {
        return verifyGate(
          ctx.previousNewest ? { ...check, previousNewest: ctx.previousNewest } : check,
        );
      } catch (err) {
        // The evidence lacked what the record must be checked against: the gate does not hold.
        return { ok: false, kind: 'missing', reason: err instanceof Error ? err.message : '' };
      }
    };

    const status = itemStatus(issue.labels, events);
    const approved = verdict('approved');
    const why = notAdmitted(approved, brief);
    const item: Candidate = {
      issue,
      state: status.state,
      ...(approved.ok && approved.record.branch ? { branch: approved.record.branch } : {}),
    };
    const gather = async (): Promise<StationEvidence> =>
      why === undefined && !FINAL.includes(item.state) ? ctx.gatherEvidence(item, config) : {};
    let found = await gather();
    const verdicts = {
      approved,
      'spec-approved': verdict('spec-approved', found.specSha),
      waiver: verdict('waiver'),
    };
    const forged = GATES.find((g) => isForged(verdicts[g]));
    if (why !== undefined && forged === undefined) {
      result.skipped.push({ issue: issue.number, reason: why });
      continue;
    }

    const tiers = issue.labels.flatMap((l) => /^tier:([123])$/.exec(l)?.[1] ?? []).map(Number);
    const evidence = () => ({
      ...found,
      ...(tiers.length > 0 ? { proposedTier: Math.max(...tiers) as Tier } : {}),
      owner: verdicts,
      rotationPending: false,
      historySigned: true,
    });
    const decision = nextTransition(status, evidence(), pause);
    if (decision.ok) {
      await addLabel(repo, issue.number, `state:${decision.to}`, options);
      for (const label of issue.labels)
        if (label.startsWith('state:') && label !== `state:${decision.to}`)
          await removeLabel(repo, issue.number, label, options);
      const from = item.state;
      result.moves.push({ issue: issue.number, from, to: decision.to, reason: decision.reason });
      if (decision.to === 'escalated') {
        const text = `#${String(issue.number)} escalated: ${decision.reason}`;
        await alertOnce({ urgency: 'urgent', kind: 'tampering', text });
        await ctx.logEvent(issue.number, {
          kind: 'alert',
          station: STATION_OF[from] ?? 1,
          ...(forged === undefined ? {} : { gate: forged }),
          pass: false,
          evidence: decision.reason,
        });
      }
      item.state = decision.to;
      found = await gather();
    }

    const at = WORK_STATION[item.state];
    if (why !== undefined || target !== undefined || at === undefined) continue;
    if (!found.needsSession || pause.stations.has(at)) continue;
    if (ownerBasisMissing(item.state, evidence()) !== undefined) continue;
    const branch = at === 1 ? 'main' : at === 7 ? 'claude/factory-log' : item.branch;
    if (branch !== undefined) target = { item, station: at, branch };
  }

  if (target === undefined) return result;
  const { item, station, branch } = target;
  let launcher;
  try {
    launcher = selectLauncher(config, ctx.launchers);
  } catch (err) {
    if (!(err instanceof RefusedError)) throw err;
    const kind = config.agents === undefined ? 'consent-missing' : 'launcher-missing';
    await alertOnce({ urgency: 'urgent', kind, text: err.message });
    return { ...result, refused: err.message };
  }
  if (!(await launcher.available()))
    return { ...result, refused: `the ${launcher.mode} launcher is unavailable` };
  const role = ROLE_AT[station];
  const prompt = `Station ${String(station)} (${STATIONS[station]}) for ${repo}#${String(item.issue.number)} on branch ${branch}.`;
  const { sessionId } = await launcher.launch({
    role,
    station,
    item: item.issue.number,
    branch,
    prompt,
  });
  const mode = launcher.mode;
  return {
    ...result,
    launched: { issue: item.issue.number, station, role, branch, mode, sessionId },
  };
}
