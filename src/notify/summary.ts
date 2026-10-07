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
  gate: Extract<ApprovalGate, 'approved' | 'spec-approved' | 'waiver' | 'resume'>;
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
}

export type Summary = { ok: true; text: string } | { ok: false; missing: string[] };

/** A part's lines, or the reason it cannot be given. */
type Part = string[] | { missing: string };

/** Removes control (Cc), format (Cf), line (Zl) and paragraph (Zp) characters, except newline. */
export const clean = (text: string) => text.replace(/(?!\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
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

const noPause = { missing: 'the pause could not be read from the inbox label history' };

function changed(f: SummaryFacts, gate: SummaryGate): Part {
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
  return lines;
}

function mapping(f: SummaryFacts, gate: SummaryGate): Part {
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

function results(f: SummaryFacts, gate: SummaryGate): Part {
  if (gate === 'waiver-code' && !CODE_CHECKS.has(checkName(f)))
    return {
      missing: `this release has no ${checkName(f)} check yet, so there is nothing to waive`,
    };
  const report = f.files?.verify;
  if (report === undefined) return { missing: `no reports/verify.md on ${f.branch ?? ''}` };
  const r = checkVerifyReport(report);
  const lines = r.complete ? ['reports/verify.md: all checks pass'] : r.missing;
  return quoted(source(f, 'reports/verify.md'), lines);
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
  const tier = `Tier ${String(f.tier)}`;
  if (gate === 'admission') return [tier, ...labels];
  if (gate === 'waiver-code')
    return {
      missing: `what the waiver lets through comes from the ${checkName(f)} check, which this release does not have yet`,
    };
  if (gate === 'waiver-prebuild') return [tier];
  const spec = f.files?.spec;
  if (spec === undefined) return noSpec(f);
  const listed = specSection(spec, 'Risks');
  if (listed.length > 0) return [tier, ...quoted(source(f), listed)];
  if (f.tier === 3) return { missing: 'tier 3 needs a Risks section in spec.md' };
  return [tier, 'none identified (spec.md has no Risks section; required only at tier 3)'];
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
