// Approval summary (FR-043, AC-016, AC-091–AC-096; data-model § Approval summary). Every signing
// command shows it before asking for the passphrase. Each gate's list below marks every part
// required, not applicable (—) or shown when available; a missing required part refuses the
// signature, and nothing in the summary can mark a required part not applicable. The command
// builds every part itself from the issue and the files at the one commit it read, never from an
// agent's summary. Agent-written text is quoted with its source, and every line is cleaned by
// Unicode category so no text can hide or fake a line. Usage comes from `events.jsonl`, which is
// telemetry: it is never required, and never blocks or allows a signature.
import { isCodeGateWaiver } from '../approvals/record.js';
import type { ApprovalGate, Tier } from '../model/types.js';
import { parseTasks } from '../stations/checks/plan.js';
import { namesId } from '../ci/ac-map.js';
import { checkSpec, meaningful, section } from '../stations/checks/spec.js';
import { checkVerifyReport } from '../stations/checks/verify.js';

export type SummaryPart = 'changed' | 'mapping' | 'results' | 'usage' | 'risks';

export const PART_TITLES: Readonly<Record<SummaryPart, string>> = {
  changed: 'What changed',
  mapping: 'Spec mapping',
  results: 'Tests and review',
  usage: 'Usage spent',
  risks: 'Known risks',
};

/** `shown`: displayed when available, else "unavailable (telemetry missing)"; never required. */
export type PartRule = 'required' | 'n/a' | 'shown';

export type SummaryGate =
  | 'admission'
  | 'spec'
  | 'waiver-prebuild'
  | 'waiver-code'
  | 'waiver-other'
  | 'merge'
  | 'merge-branch'
  | 'deploy'
  | 'resume';

const R = 'required';
const NA = 'n/a';
const S = 'shown';

/** The per-gate list of data-model § Approval summary, pinned with the release. */
export const GATE_PARTS: Readonly<Record<SummaryGate, Readonly<Record<SummaryPart, PartRule>>>> = {
  admission: { changed: R, mapping: NA, results: NA, usage: S, risks: R },
  spec: { changed: R, mapping: R, results: NA, usage: S, risks: R },
  'waiver-prebuild': { changed: R, mapping: NA, results: NA, usage: S, risks: R },
  'waiver-code': { changed: R, mapping: R, results: R, usage: S, risks: R },
  'waiver-other': { changed: R, mapping: NA, results: NA, usage: NA, risks: R },
  merge: { changed: R, mapping: R, results: R, usage: S, risks: R },
  'merge-branch': { changed: R, mapping: NA, results: R, usage: NA, risks: R },
  deploy: { changed: R, mapping: NA, results: R, usage: S, risks: R },
  resume: { changed: R, mapping: NA, results: NA, usage: NA, risks: R },
};

/** Why `factory merge` refuses a tier 3 item or a change under `formal/` (T066, T068). */
export const NO_FORMAL = 'the formal check is not in this release';

/** Code gates whose check this release runs; a waiver for any other has nothing to skip. */
export const CODE_CHECKS: ReadonlySet<string> = new Set();

/** Resume (AC-096): the pause being lifted, and what happened while it held. */
export interface PauseFacts {
  label: string;
  /** When and by whom the pause began, from the inbox label history. */
  at: string;
  by: string | undefined;
  /** Alerts posted on the inbox since then. */
  alerts: readonly { at: string; urgency: string; kind: string; text: string }[];
  /** Items with a `state:` label added since then, and those labels in order (What changed). */
  items: readonly { number: number; title: string; states: readonly string[] }[];
}

export interface SummaryFacts {
  gate: Extract<ApprovalGate, 'approved' | 'spec-approved' | 'waiver' | 'resume'> | 'merge';
  /** The row of the per-gate list; derived from `gate` when absent (merge and deploy set it). */
  kind?: SummaryGate | undefined;
  issue: { number: number; title: string; body: string; labels: readonly string[] };
  tier?: Tier | undefined;
  /** The item branch; absent when the issue is not a work item. */
  branch?: string | undefined;
  waives?: string | undefined;
  head?: string | undefined;
  /** The one commit every file was read at. */
  commit?: string | undefined;
  /** Feature files at `commit`; absent before the branch exists. */
  files?:
    | {
        spec?: string | undefined;
        tasks?: string | undefined;
        verify?: string | undefined;
        events?: string | undefined;
      }
    | undefined;
  pause?: PauseFacts | undefined;
  /** Spec re-approval: the last approved blob and the diff from it (undefined: not available). */
  previousSpec?: { blob: string; diff: string | undefined } | undefined;
  /** A `test:` waiver: the weakened findings at `commit` it covers, from the laptop's own run. */
  covered?: readonly { target: string; what: string }[] | undefined;
  /** Re-signing a head-bound waiver: the earlier waiver's head and what changed since (T151). */
  resign?: { head: string; kind: 'diff' | 'interdiff' | 'gone'; text: string } | undefined;
  /** `factory merge` of a work item: what its checks found at `commit` (T068). */
  merge?: MergeView | undefined;
  /** `factory merge` of a Define, log or factory-repository branch (T068, slice 22c). */
  branchMerge?: BranchMergeView | undefined;
}

/** What `factory merge`'s checks found for a work item at the checked head; nothing is re-run. */
export interface MergeView {
  pr: { number: number; title: string };
  diffstat: readonly { path: string; status: string; added: number; removed: number }[];
  /** Every changed test file, whatever its line counts. */
  testFiles: readonly string[];
  /** `edges.ts`'s early warning: shown, never a refusal; only the sandboxed run decides. */
  early: {
    findings: readonly { message: string; target: string; waiver?: string | undefined }[];
    problems: readonly string[];
    /** Issues quarantines name; agent-writable, so never verified here. */
    quarantines: readonly number[];
  };
  /** The sandboxed weakened run's findings, each covered by a `test:` waiver in force. */
  weakened: readonly { target: string; what: string; waiver?: string | undefined }[];
  /** Titles of the head's tests that pass cleanly. */
  passing: readonly string[];
  /** The checked set of acceptance criteria. */
  checked: readonly string[];
  ci: readonly {
    job: string;
    workflow: string;
    state: string;
    failedBefore: number;
    failedRuns: number;
  }[];
  redGreen: { skipped: true; files: readonly string[] } | { skipped: false; checked: number };
  /** Waiver targets in force at the checked head. */
  waivers: readonly string[];
}

/**
 * What `factory merge`'s checks found for a Define, log or factory-repository branch. The branch
 * may be behind main, so what lands is git's merge of the two: the diffstat is the merge result's
 * against main (data-model § Approval summary).
 */
export interface BranchMergeView {
  pr: { number: number; title: string };
  branch: string;
  /** The merge rule that applied. */
  rule: string;
  head: string;
  main: string;
  /** The merge base of main and the head; main itself when main has not moved. */
  base: string;
  diffstat: MergeView['diffstat'];
  ci: MergeView['ci'];
  /** The branch's own check results, computed on this laptop. */
  checks: readonly string[];
}

export type Summary = { ok: true; text: string } | { ok: false; missing: string[] };

/** A part's lines, or the reason it cannot be given. */
type Part = string[] | { missing: string };

/** Removes control (Cc), format (Cf), line (Zl) and paragraph (Zp) characters, except newline. */
export const clean = (text: string) => text.replace(/(?!\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
/**
 * Untrusted text (test titles, diff lines) with every control, format, line and paragraph
 * character, and every space but U+0020, shown as an escape, a newline as `\n`, so no text can
 * hide or fake a line or pass for other text.
 */
export const visible = (text: string) =>
  text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|(?! )\p{Zs}/gu, (c) =>
    c === '\n' ? '\\n' : `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`,
  );
const plain = (line: string) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim();
const short = (sha: string) => sha.slice(0, 12);
const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

export function summaryGate(f: SummaryFacts): SummaryGate {
  if (f.kind !== undefined) return f.kind;
  if (f.gate === 'resume') return 'resume';
  if (f.gate === 'approved') return 'admission';
  if (f.gate === 'spec-approved') return 'spec';
  if (f.branch === undefined) return 'waiver-other';
  return isCodeGateWaiver(f.waives ?? '') ? 'waiver-code' : 'waiver-prebuild';
}

/** Agent-written lines with their source, or nothing when there are none. */
function quoted(source: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : [`quoted from ${source}:`, ...lines.map((l) => `> ${l}`)];
}

/** A feature file as a quoted source: `specs/<feature>/<name> at <commit>`. */
function source(f: SummaryFacts, name = 'spec.md'): string {
  const dir = `specs/${(f.branch ?? '').slice('claude/'.length)}`;
  return `${dir}/${name}${f.commit ? ` at ${short(f.commit)}` : ''}`;
}

/** The meaningful lines of a spec section, without list markers. */
function specSection(spec: string, name: string): string[] {
  const lines = spec.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  return (section(lines, name) ?? []).filter(meaningful).map(plain);
}

const noSpec = (f: SummaryFacts) => ({ missing: `no spec.md on ${f.branch ?? 'the branch'}` });
const checkName = (f: SummaryFacts) => (f.waives ?? '').slice('gate:'.length);

const noMerge = { missing: "the merge checks' results were not passed in" };

/** Open findings from the verify report, and the waivers in force at the checked head. */
function mergeRisks(f: SummaryFacts): string[] {
  const open = f.files?.verify === undefined ? [] : checkVerifyReport(f.files.verify).open;
  return [
    ...(open.length === 0
      ? ['Open findings: none in reports/verify.md']
      : ['Open findings:', ...quoted(source(f, 'reports/verify.md'), open.map(visible))]),
    `Waivers in force: ${(f.merge?.waivers ?? []).map(visible).join(', ') || 'none'}`,
  ];
}

const noPause = { missing: 'the pause could not be read from the inbox label history' };

const each = (lines: readonly string[]) => (lines.length === 0 ? ['none'] : lines);
const counted = (n: number, what: string) =>
  n === 0 ? [] : [`${plural(n, `earlier ${what}`)} failed`];

/** The item merge's What changed: every string from the branch shown through visible(). */
function mergeChanged(f: SummaryFacts, m: MergeView): string[] {
  const early = m.early;
  return [
    `Request #${String(f.issue.number)}: ${visible(f.issue.title)}`,
    `Pull request #${String(m.pr.number)}: ${visible(m.pr.title)}`,
    `Checked head ${f.commit ?? ''}`,
    `${plural(m.diffstat.length, 'file')} changed since the merge base:`,
    ...m.diffstat.map(
      (d) => `${d.status} +${String(d.added)} -${String(d.removed)} ${visible(d.path)}`,
    ),
    'Changed test files (each listed, even when its counts net to zero):',
    ...each(m.testFiles.map(visible)),
    'Early warning from the test-diff rules (shown only; the sandboxed run below decides):',
    ...each([
      ...early.findings.map(
        (e) =>
          `${visible(e.message)}; waiver: ${e.waiver === undefined ? 'none' : visible(e.waiver)}`,
      ),
      ...early.problems.map(visible),
      ...early.quarantines.map((n) => `quarantined per #${String(n)} (not verified)`),
    ]),
    `Weakened at the checked head (sandboxed run):`,
    ...each(
      m.weakened.map(
        (w) =>
          `${visible(w.target)}: ${visible(w.what)}; covered by ${w.waiver === undefined ? 'none' : visible(w.waiver)}`,
      ),
    ),
  ];
}

const mergeMapping = (m: MergeView): string[] =>
  m.checked.map((id) => {
    const tests = m.passing.filter((t) => namesId(t, id)).map(visible);
    return `${id} → ${tests.length > 0 ? tests.join('; ') : 'no passing test'}`;
  });

const ciLines = (ci: MergeView['ci']): string[] =>
  ci.length === 0
    ? []
    : [
        'CI on the checked head (GitHub Actions workflow runs):',
        ...ci.map((j) =>
          [
            `${j.job} (${j.workflow}): ${j.state}`,
            ...counted(j.failedBefore, 'attempt'),
            ...counted(j.failedRuns, 'run'),
          ].join('; '),
        ),
      ];

function mergeResults(m: MergeView): string[] {
  const rg = m.redGreen;
  return [
    ...ciLines(m.ci),
    rg.skipped
      ? `red-green skipped: only test code changed (${rg.files.map(visible).join(', ')})`
      : `red-green: ${String(rg.checked)} ${rg.checked === 1 ? 'criterion goes' : 'criteria go'} from failing to passing`,
    'ac-map: every checked criterion has a passing test',
  ];
}

/** A Define, log or factory-repository merge: each part from its view, or the part is missing. */
const BRANCH_PARTS: Readonly<
  Record<'changed' | 'results' | 'risks', (b: BranchMergeView) => string[]>
> = {
  changed: (b) => [
    `Pull request #${String(b.pr.number)}: ${visible(b.pr.title)}`,
    `Branch ${visible(b.branch)} at ${b.head}, onto main at ${b.main}`,
    `${plural(b.diffstat.length, 'file')} changed by the merge result against main (what lands):`,
    ...b.diffstat.map(
      (d) => `${d.status} +${String(d.added)} -${String(d.removed)} ${visible(d.path)}`,
    ),
  ],
  results: (b) => [...ciLines(b.ci), ...b.checks.map(visible)],
  risks: (b) => [
    `The ${b.rule} rule passes at the checked head and on the merge result`,
    b.base === b.main
      ? 'Main has not moved since the branch was cut'
      : `Main moved since the branch was cut at ${b.base}: what lands is git's merge of the two, checked above`,
  ],
};

const branchPart = (f: SummaryFacts, key: keyof typeof BRANCH_PARTS): Part =>
  f.branchMerge === undefined ? noMerge : BRANCH_PARTS[key](f.branchMerge);

function changed(f: SummaryFacts, gate: SummaryGate): Part {
  if (gate === 'merge-branch') return branchPart(f, 'changed');
  if (gate === 'merge') return f.merge === undefined ? noMerge : mergeChanged(f, f.merge);
  if (gate === 'resume') {
    const p = f.pause;
    if (p === undefined) return noPause;
    if (p.items.length === 0) return ['No item changed state since the pause'];
    const items = p.items.map((i) => `#${String(i.number)} ${i.title}: ${i.states.join(' → ')}`);
    return ['Items whose state changed since the pause:', ...items];
  }
  const lines = [`Request #${String(f.issue.number)}: ${f.issue.title}`];
  if (gate === 'admission') {
    const body = f.issue.body.split('\n').filter((l) => l.trim() !== '');
    return [...lines, ...quoted(`issue #${String(f.issue.number)}`, body)];
  }
  if (gate === 'spec') {
    const prev = f.previousSpec;
    const spec = f.files?.spec;
    if (prev?.diff !== undefined) {
      if (prev.diff.trim() === '')
        return [...lines, `spec.md is unchanged since the approved blob ${short(prev.blob)}`];
      const head = `spec.md changed since the approved blob ${short(prev.blob)} (diff to ${short(f.commit ?? '')}):`;
      return [...lines, head, ...prev.diff.split('\n').map((l) => `> ${l}`)];
    }
    if (spec === undefined) return noSpec(f);
    if (prev !== undefined) {
      // Showing more is safe; refusing would block re-approval for good after a rebase.
      const which = prev.blob === '' ? '' : ` ${short(prev.blob)}`;
      const why = `the previously approved spec.md${which} is not available: showing the full spec`;
      return [...lines, why, ...quoted(source(f), spec.replace(/\n$/, '').split('\n'))];
    }
    const sections = ['Problem', 'Affected areas'].map(
      (name) => `${name}: ${specSection(spec, name).join('; ') || 'none given'}`,
    );
    return [...lines, ...quoted(source(f), sections)];
  }
  if (gate.startsWith('waiver')) lines.push(`Waives ${f.waives ?? ''}`);
  if (f.head !== undefined) lines.push(`PR head ${f.head}`);
  const r = f.resign;
  if (r === undefined) return lines;
  const label = {
    diff: `diff since the waived head ${r.head}:`,
    interdiff: `interdiff since the waived head ${r.head}:`,
    gone: `the waived head ${r.head} is gone, so this is the full diff from the merge base:`,
  }[r.kind];
  const diff = r.text.replace(/\n$/, '').split('\n');
  return [...lines, label, ...diff.map((l) => `> ${visible(l)}`)];
}

function mapping(f: SummaryFacts, gate: SummaryGate): Part {
  if (gate === 'merge') return f.merge === undefined ? noMerge : mergeMapping(f.merge);
  const spec = f.files?.spec;
  if (spec === undefined) return noSpec(f);
  const { acs } = checkSpec(spec);
  if (acs.length === 0) return { missing: 'spec.md defines no acceptance criteria' };
  if (gate === 'spec') {
    const text = new Map<string, string>();
    for (const line of spec.split('\n')) {
      const m = /\*\*(AC-\d+)\*\*\s*[—–-]?\s*(.*)$/.exec(line);
      if (m && !text.has(m[1] ?? '')) text.set(m[1] ?? '', (m[2] ?? '').replace(/\*\*/g, ''));
    }
    return quoted(
      source(f),
      acs.map((ac) => `${ac}: ${text.get(ac) ?? ''}`.trim()),
    );
  }
  const testTasks = parseTasks(f.files?.tasks ?? '').filter((t) => t.test);
  return acs.map((ac) => {
    const ids = testTasks.filter((t) => new RegExp(`\\b${ac}\\b`).test(t.text)).map((t) => t.id);
    return `${ac} → ${ids.length > 0 ? ids.join(', ') : 'no test task yet'}`;
  });
}

const isTestWaiver = (f: SummaryFacts) => (f.waives ?? '').startsWith('test:');

function results(f: SummaryFacts, gate: SummaryGate): Part {
  if (gate === 'merge-branch') return branchPart(f, 'results');
  if (isTestWaiver(f)) {
    const covered = f.covered ?? [];
    if (covered.length === 0)
      return { missing: `${f.waives ?? ''} covers no weakened test at ${short(f.commit ?? '')}` };
    const head = `weakened tests at ${short(f.commit ?? '')} this waiver covers (run on this laptop):`;
    return [head, ...covered.map((c) => `${visible(c.target)}: ${c.what}`)];
  }
  if (gate === 'waiver-code' && !CODE_CHECKS.has(checkName(f)))
    return {
      missing: `this release has no ${checkName(f)} check yet, so there is nothing to waive`,
    };
  const report = f.files?.verify;
  if (report === undefined) return { missing: `no reports/verify.md on ${f.branch ?? ''}` };
  const r = checkVerifyReport(report);
  const lines = r.complete ? ['reports/verify.md: all checks pass'] : r.missing;
  if (gate !== 'merge') return quoted(source(f, 'reports/verify.md'), lines);
  if (f.merge === undefined) return noMerge;
  return [...mergeResults(f.merge), ...quoted(source(f, 'reports/verify.md'), lines.map(visible))];
}

function usage(f: SummaryFacts): Part {
  const events = f.files?.events;
  if (events === undefined) return [];
  let sessions = 0;
  let share = 0;
  let counted = 0;
  let unreadable = 0;
  for (const line of events.split('\n')) {
    if (line.trim() === '') continue;
    let e: { kind?: unknown; usage?: { sessions?: unknown; est_share?: unknown } };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      unreadable += 1;
      continue;
    }
    if (e.kind !== 'usage') continue;
    const s = e.usage?.sessions;
    const x = e.usage?.est_share;
    if (!Number.isSafeInteger(s) || typeof x !== 'number' || !(x >= 0 && x <= 1)) {
      unreadable += 1;
      continue;
    }
    sessions += s as number;
    share += x;
    counted += 1;
  }
  const lines = [
    `${plural(sessions, 'session')}, about ${String(Math.round(share * 100))}% of the plan's usage, from ${plural(counted, 'usage event')} in events.jsonl (telemetry, unverified)`,
  ];
  if (unreadable > 0) lines.push(`${plural(unreadable, 'unreadable line')} not counted`);
  return lines;
}

function risks(f: SummaryFacts, gate: SummaryGate): Part {
  if (gate === 'merge-branch') return branchPart(f, 'risks');
  if (gate === 'resume') {
    const p = f.pause;
    if (p === undefined) return noPause;
    // Agents act through the Owner's account, so the login says which account, not who.
    const by = p.by === undefined ? 'a deleted account' : `${p.by} (GitHub)`;
    const alerts = p.alerts.map((a) => `${a.at} ${a.urgency} ${a.kind}: ${a.text}`);
    return [
      `${p.label} added at ${p.at} by ${by}`,
      ...(alerts.length > 0
        ? quoted(`the inbox #${String(f.issue.number)}`, alerts)
        : ['No alert raised during the pause']),
    ];
  }
  const others = f.issue.labels.filter((l) => !/^(?:tier|owner|state|pause):/.test(l));
  const labels = others.length > 0 ? [`Other labels: ${others.join(', ')}`] : [];
  if (gate === 'waiver-other') {
    const target = f.waives ?? '';
    const what = target.startsWith('finding:') ? 'the finding stays unfixed' : 'accepted as is';
    return [`Waiver of ${target} on #${String(f.issue.number)}: ${what}`, ...labels];
  }
  if (f.tier === undefined)
    return { missing: 'no tier (give one with --tier or a single proposed tier: label)' };
  // Until a release has `factory ci formal`, merge refuses a tier 3 item (Owner 2026-10-11).
  const tier = [
    `Tier ${String(f.tier)}`,
    ...(f.tier === 3 ? [`${NO_FORMAL}: factory merge refuses a tier 3 item`] : []),
  ];
  if (gate === 'admission') return [...tier, ...labels];
  if (gate === 'waiver-code' && isTestWaiver(f)) {
    const n = (f.covered ?? []).length;
    return [...tier, `What it lets through: ${plural(n, 'weakened test')}, listed above`];
  }
  if (gate === 'waiver-code')
    return {
      missing: `what the waiver lets through comes from the ${checkName(f)} check, which this release does not have yet`,
    };
  if (gate === 'waiver-prebuild') return tier;
  const spec = f.files?.spec;
  if (spec === undefined) return noSpec(f);
  const listed = specSection(spec, 'Risks');
  const merge = gate === 'merge' ? mergeRisks(f) : [];
  if (listed.length > 0)
    return [
      ...tier,
      ...quoted(source(f), gate === 'merge' ? listed.map(visible) : listed),
      ...merge,
    ];
  if (f.tier === 3) return { missing: 'tier 3 needs a Risks section in spec.md' };
  return [
    ...tier,
    'none identified (spec.md has no Risks section; required only at tier 3)',
    ...merge,
  ];
}

const PARTS: Readonly<Record<SummaryPart, (f: SummaryFacts, gate: SummaryGate) => Part>> = {
  changed,
  mapping,
  results,
  usage: (f) => usage(f),
  risks,
};

/** The summary to show before signing, or every required part that cannot be given. */
export function buildSummary(facts: SummaryFacts): Summary {
  const gate = summaryGate(facts);
  const out: string[] = [];
  const missing: string[] = [];
  for (const [key, title] of Object.entries(PART_TITLES) as [SummaryPart, string][]) {
    const rule = GATE_PARTS[gate][key];
    const part = rule === 'n/a' ? ['—'] : PARTS[key](facts, gate);
    if (Array.isArray(part) && part.length > 0)
      out.push(title, ...part.map((l) => `  ${clean(l)}`));
    else if (rule === 'shown') out.push(title, '  unavailable (telemetry missing)');
    else missing.push(`${title}: ${Array.isArray(part) ? 'nothing to show' : part.missing}`);
  }
  if (missing.length > 0) return { ok: false, missing };
  const at = facts.commit === undefined ? '' : ` at ${facts.commit}`;
  const head = `Approval summary for #${String(facts.issue.number)} (${facts.gate})${at}:`;
  const legend =
    'Lines after "quoted from" are agent text; everything else is computed on this laptop.';
  return { ok: true, text: `${clean(head)}\n${legend}\n\n${out.join('\n')}\n` };
}
