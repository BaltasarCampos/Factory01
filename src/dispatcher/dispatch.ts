// One dispatcher pass (contracts/cli.md `factory dispatch`, FR-016f): read the config on main,
// check the two copies of the Owner key, derive pause state, admit issues, verify every `owner:`
// label, apply each item's transition through `state:` labels, and start at most one session.
//
// The dispatcher is itself an agent session with a shell, so its decisions are advisory
// (data-model.md § State machine): only signed records, signed commits and the laptop's checks
// decide what reaches main. Station evidence (T060) and the signed-history audit (T139) are
// supplied by the caller: a first-parent commit the Owner did not sign halts the line with an
// urgent tampering alert, and an item branch pushed again after its merge raises one. On `new → triaged` the pass creates the item branch, and before a session
// on it (stations 2–6) it opens the item's one draft PR and commits `.station.json`. Nothing is
// admitted before main has the Owner-signed Define merge, and when main's key lists or
// `git verify-commit` cannot be read or run the pass admits nothing, moves nothing and alerts the
// Owner. An item Intake marked a duplicate waits in `new`, and the Owner gets one info alert per
// marker comment (slice 24a-2).
import { checkSecondCopy, type KeyCheck, type ReleaseKeys } from '../approvals/keys.js';
import { verifyGate, type PostedComment, type Verdict } from '../approvals/verify.js';
import { RefusedError } from '../cli/env.js';
import type { KeysFor } from '../git/history.js';
import { briefMerged, verifiedMerges, type MainMerges } from '../git/merges.js';
import { listComments } from '../github/comments.js';
import type { GhOptions } from '../github/gh.js';
import { addLabel, removeLabel } from '../github/labels.js';
import { timeline } from '../github/timeline.js';
import { configOnMain } from '../model/config.js';
import {
  STATES,
  type AgentsMode,
  type Event,
  type ProjectConfig,
  type RoleName,
  type State,
  type Station,
  type Tier,
} from '../model/types.js';
import { alert, parseAlert, type InboxTarget, type NewAlert } from '../notify/inbox.js';
import { duplicateOf } from '../stations/checks/intake.js';
import { derivePause, resumeEntries, type LabelEvent } from '../pause/derive.js';
import { listOpenIssues, notAdmitted, type IssueSummary } from './admission.js';
import {
  createItemBranch,
  ensureDraftPr,
  featureOf,
  git as runGit,
  type BranchContext,
  type ItemRef,
} from './branch.js';
import { itemOf, type HistoryAudit } from './history-audit.js';
import { selectLauncher } from './launcher/select.js';
import { LaunchRefused, SessionFailed, type Launchers, type Notice } from './launcher/types.js';
import { tickTask, writeStationManifest } from './manifest.js';
import { fileAt, signedAnswers } from '../git/answers.js';
import { branchFeatureDir } from '../model/naming.js';
import type { PromptFacts } from './prompts.js';
import { answersToApply, parseAnswers, type QuestionFile } from '../stations/checks/questions.js';
import { isReleased, releasedHeads } from './released.js';
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
  /** Verify's next role by the Owner's tier (T181). */
  verifyRole?: RoleName;
  /** Build's task passed CI's build-test at the Builder's head: the factory ticks it (T174). */
  tick?: { task: string; head: string };
  /** Why the Builder gets its task again: CI's build-test red at its head (T174). */
  buildFailure?: string;
  /** A commit that makes the branch's `answers.md` not the Owner's: its answers count as none (T182). */
  answersTampered?: { commit: string; reason: string };
};

export interface Candidate {
  issue: IssueSummary;
  state: State;
  /** The branch named by the verified `owner:approved` record. */
  branch?: string;
  /** The tier that record confirms. */
  tier?: Tier;
}

export type DispatchEvent = Pick<Event, 'kind' | 'station' | 'gate' | 'pass' | 'evidence'>;

export interface DispatchContext {
  /** A clone of the project; the caller fetches `mainRef` first. */
  projectDir: string;
  /** Default `origin/main`. */
  mainRef?: string;
  /** Key lists of a release pinned on main (src/approvals/keys.ts `releaseKeysFor`). */
  keysFor: KeysFor;
  secondCopy: string | undefined;
  previousNewest?: string;
  /** src/dispatcher/history-audit.ts `auditMain` over the pass's walk of main. */
  auditHistory: (config: ProjectConfig, main: MainMerges) => Promise<HistoryAudit>;
  gatherEvidence: (
    item: Candidate,
    config: ProjectConfig,
    main: MainMerges,
    /** Main's verified key lists, which the Owner's answers must be signed under (T182). */
    keys: ReleaseKeys,
  ) => Promise<StationEvidence>;
  launchers: Launchers;
  /** The station's prompt, rendered from the release pinned at `pin` (src/dispatcher/prompts.ts). */
  stationPrompt: (pin: string, facts: PromptFacts) => string;
  /** Records an event for the item; where it is written is the caller's choice. */
  logEvent: (issue: number, event: DispatchEvent) => Promise<void>;
  /** The clock for `.station.json`'s `issued_at`; default the system clock. */
  now?: () => Date;
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
  /** A session that ran and failed, which used the Owner's plan: never "no session started". */
  failed?: string;
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
  5: 'test', // unused: Verify's role comes from its evidence (T181)
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

/** The files the item's pull request changes: its branch against the merge base with main. */
export function changedFiles(at: BranchContext, mainRef: string, branch: string): string[] {
  const diff = runGit(at, ['diff', '--name-only', '-z', `${mainRef}...origin/${branch}`]);
  return diff.split('\0').filter(Boolean);
}

/**
 * The Owner's answers that Specify (`spec.md`) or Plan (`plan.md`) applies next, read at the item
 * branch's tip as origin has it (T180).
 */
export function ownerAnswers(
  at: BranchContext,
  branch: string,
  file: QuestionFile,
  keys: ReleaseKeys,
  mainRef = 'origin/main',
): string[] {
  const dir = branchFeatureDir(branch);
  if (dir === undefined) return [];
  const tip = runGit(at, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]);
  const base = runGit(at, ['merge-base', mainRef, tip]);
  const env = at.env ?? process.env;
  const signed = signedAnswers({
    repo: at.projectDir,
    tip,
    base,
    path: `${dir}/answers.md`,
    keys,
    env,
  });
  // Answers that are not the Owner's count as none; the evidence has alerted the Owner.
  if ('tampered' in signed) return [];
  const show = (name: string) => fileAt(at.projectDir, tip, `${dir}/${name}`, env);
  const files = { spec: show('spec.md'), plan: show('plan.md') };
  return answersToApply(files, parseAnswers(signed.text), file);
}

/** Main's commits since the newest verified deploy on its history, or all of main before one. */
export function sinceLastDeploy(
  main: Pick<MainMerges, 'commits'>,
  released: ReadonlySet<string>,
  mainRef: string,
): string {
  const last = main.commits.findLast((c) => released.has(c.commit));
  return last === undefined ? mainRef : `${last.commit}..${mainRef}`;
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

  /** Main cannot be checked: admit nothing, move nothing, alert the Owner once. */
  const unverifiable = async (err: unknown): Promise<PassResult> => {
    const reason = `cannot verify main, so nothing is admitted: ${err instanceof Error ? err.message : String(err)}`;
    await alertOnce({ urgency: 'urgent', kind: 'unverifiable', text: `line stopped: ${reason}` });
    return { ...result, halted: reason };
  };
  let history: MainMerges;
  let audit: HistoryAudit;
  try {
    history = verifiedMerges(ctx.projectDir, ctx.keysFor, {
      ref: ctx.mainRef ?? 'origin/main',
      baseline: config.baseline,
    });
    audit = await ctx.auditHistory(config, history);
  } catch (err) {
    return unverifiable(err);
  }
  if (audit.unsigned !== undefined) {
    const text = `line stopped: ${audit.unsigned}`;
    await alertOnce({ urgency: 'urgent', kind: 'tampering', text });
    return { ...result, halted: audit.unsigned };
  }
  for (const branch of audit.recreated) {
    const text = `${branch} was pushed again after #${String(itemOf(branch))} was merged`;
    await alertOnce({ urgency: 'urgent', kind: 'tampering', text });
  }
  const brief = briefMerged(history);
  // The tip's pin is read only now that every commit up to the tip is Owner-signed.
  let keys: ReleaseKeys;
  let keyCheck: KeyCheck;
  try {
    keys = ctx.keysFor(config.factory_release);
    keyCheck = checkSecondCopy(keys, ctx.secondCopy, ctx.previousNewest);
  } catch (err) {
    return unverifiable(err);
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
  const released = releasedHeads(inboxComments, { keys, repo, inboxIssue: config.inbox_issue });
  if (pause.line) return { ...result, halted: 'pause:line in effect' };

  const git = { projectDir: ctx.projectDir, now: ctx.now ?? (() => new Date()) };
  const mainRef = ctx.mainRef ?? 'origin/main';
  type Target = {
    item: Candidate;
    station: Station;
    role: RoleName;
    branch: string;
    comments: PostedComment[];
    failure?: string;
  };
  let target: Target | undefined;
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
      ...(approved.ok && approved.record.tier ? { tier: approved.record.tier } : {}),
    };
    const gather = async (): Promise<StationEvidence> =>
      why === undefined && !FINAL.includes(item.state)
        ? ctx.gatherEvidence(item, config, history, keys)
        : {};
    let found = await gather();
    if (found.tick !== undefined && item.branch !== undefined) {
      const { task, head } = found.tick;
      tickTask(git, { issue: issue.number, branch: item.branch }, task, head);
      found = await gather();
    }
    if (found.answersTampered !== undefined) {
      const { commit, reason } = found.answersTampered;
      const text = `#${String(issue.number)}: answers.md on ${item.branch ?? 'its branch'} is not the Owner's: ${commit.slice(0, 12)} ${reason}; its answers count as none. If the commit is yours, close this item and file it again; if it is not, look into it before anything else.`;
      await alertOnce({ urgency: 'urgent', kind: 'tampering', text });
    }
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
      released: isReleased(released, history, issue.number),
    });
    const decision = nextTransition(status, evidence(), pause);
    if (decision.alert !== undefined) {
      const { text } = decision.alert;
      await alertOnce({ ...decision.alert, text: `#${String(issue.number)}: ${text}` });
    }
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
      if (from === 'new' && decision.to === 'triaged' && item.branch !== undefined)
        createItemBranch(git, { issue: issue.number, branch: item.branch }, comments, mainRef);
      item.state = decision.to;
      found = await gather();
    }
    const original = item.state === 'new' ? found.duplicateOf : undefined;
    if (original !== undefined) {
      // One alert per marker comment: an item un-marked and marked again gets a new one.
      const marker = comments.find((c) => duplicateOf(c.body) === original);
      const n = String(issue.number);
      await alertOnce({
        urgency: 'info',
        kind: 'duplicate',
        text: `#${n} is marked a duplicate of #${String(original)} (comment ${marker?.id ?? 'unknown'}): close #${n}, or delete the marker if it is not a duplicate`,
      });
    }

    const at = WORK_STATION[item.state];
    if (why !== undefined || target !== undefined || at === undefined) continue;
    if (!found.needsSession || pause.stations.has(at)) continue;
    if (ownerBasisMissing(item.state, evidence()) !== undefined) continue;
    const branch = at === 1 ? 'main' : at === 7 ? 'claude/factory-log' : item.branch;
    // Verify runs the role its evidence names (T181); every other station has one role.
    const role = at === 5 ? found.verifyRole : ROLE_AT[at];
    if (branch !== undefined && role !== undefined)
      target = {
        ...{ item, station: at, role, branch, comments },
        ...(found.buildFailure === undefined ? {} : { failure: found.buildFailure }),
      };
  }

  if (target === undefined) return result;
  const { item, station, role, branch, comments, failure } = target;
  let launcher;
  try {
    launcher = selectLauncher(config, ctx.launchers);
  } catch (err) {
    if (!(err instanceof RefusedError)) throw err;
    const kind = config.agents === undefined ? 'consent-missing' : 'launcher-missing';
    await alertOnce({ urgency: 'urgent', kind, text: err.message });
    return { ...result, refused: err.message };
  }
  // One alert, not one per pass: info while a launcher waits (the cloud command until T125,
  // local sessions until the guards ship), urgent when guardrail files were tampered with.
  const refuse = async (
    refused: string,
    urgent: boolean | undefined,
    kind = 'launcher-unavailable',
  ): Promise<PassResult> => {
    const text = `no session started for ${repo}: ${refused}`;
    await alertOnce(
      urgent === true
        ? { urgency: 'urgent', kind: 'tampering', text }
        : { urgency: 'info', kind, text },
    );
    return { ...result, refused };
  };
  const availability = await launcher.available(ctx.projectDir);
  if (!availability.ok)
    return refuse(
      `the ${launcher.mode} launcher is unavailable: ${availability.reason}`,
      availability.urgent,
    );
  // The feature folder and the task's files, for the session's own settings (T061).
  let session = { feature: '', files: [] as readonly string[] };
  if (station >= 2 && station <= 6) {
    const ref: ItemRef = { issue: item.issue.number, branch };
    createItemBranch(git, ref, comments, mainRef);
    await ensureDraftPr(repo, { ...ref, title: item.issue.title }, options);
    const manifest = writeStationManifest(git, ref, { station, role }, mainRef);
    session = { feature: `specs/${featureOf(ref)}`, files: manifest.files ?? [] };
  }
  const answersFor = (file: QuestionFile | undefined) => {
    const answers = file === undefined ? [] : ownerAnswers(git, branch, file, keys, mainRef);
    return answers.length === 0 ? {} : { answers };
  };
  let prompt: string;
  try {
    prompt = ctx.stationPrompt(config.factory_release.sha, {
      ...{ station, repo, issue: item.issue.number, title: item.issue.title, branch },
      body: item.issue.body,
      ...(item.branch === undefined ? {} : { itemBranch: item.branch }),
      ...(item.tier === undefined ? {} : { tier: item.tier }),
      ...(station === 5 ? { changed: changedFiles(git, mainRef, branch) } : {}),
      ...answersFor(station === 2 ? 'spec.md' : station === 3 ? 'plan.md' : undefined),
      ...(station === 7 ? { range: sinceLastDeploy(history, released, mainRef) } : {}),
      ...(failure === undefined ? {} : { failure }),
    });
  } catch (err) {
    // A release without the station's prompt or commands: no session, until the pin moves.
    if (!(err instanceof RefusedError)) throw err;
    return refuse(err.message, false, 'release-incomplete');
  }
  let sessionId: string;
  let notices: readonly Notice[] = [];
  try {
    ({ sessionId, notices = [] } = await launcher.launch({
      project: ctx.projectDir,
      role,
      station,
      item: item.issue.number,
      branch,
      ...session,
      prompt,
    }));
  } catch (err) {
    if (err instanceof SessionFailed) {
      const text = `a ${role} session for ${repo}#${String(item.issue.number)} failed: ${err.message}; nothing of it is pushed`;
      await alertOnce({ urgency: 'urgent', kind: 'session-failed', text });
      return { ...result, failed: text };
    }
    if (!(err instanceof LaunchRefused)) throw err;
    return refuse(err.message, err.urgent);
  }
  for (const { kind, text } of notices) await alertOnce({ urgency: 'info', kind, text });
  const mode = launcher.mode;
  return {
    ...result,
    launched: { issue: item.issue.number, station, role, branch, mode, sessionId },
  };
}
