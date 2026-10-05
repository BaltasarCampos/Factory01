// Approval summary (FR-043, AC-016): every Owner gate shows what changed, how it maps to the
// spec, test and review results, usage spent and known risks, and nothing is signed while any of
// the five is missing. The parts are computed from the issue and the files committed on the item
// branch, never taken from an agent's own summary. Issue and file text is untrusted: it is shown
// as quoted data, with terminal control codes replaced so it cannot hide lines from the Owner.
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

export interface SummaryFacts {
  gate: Extract<ApprovalGate, 'approved' | 'spec-approved' | 'waiver'>;
  issue: { number: number; title: string; body: string; labels: readonly string[] };
  tier?: Tier;
  /** The item branch; absent when the issue is not a work item. */
  branch?: string;
  waives?: string;
  head?: string;
  /** Feature files committed on the branch; absent before the branch exists. */
  files?:
    | {
        spec?: string | undefined;
        tasks?: string | undefined;
        verify?: string | undefined;
        events?: string | undefined;
      }
    | undefined;
}

export type Summary = { ok: true; text: string } | { ok: false; missing: string[] };

/** A part's lines, or the reason it cannot be given. */
type Part = string[] | { missing: string };

const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '?');
const plain = (line: string) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim();

/** The meaningful lines of a spec section, without list markers. */
function specSection(spec: string, name: string): string[] {
  const lines = spec.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  return (section(lines, name) ?? []).filter(meaningful).map(plain);
}

function changed(f: SummaryFacts): Part {
  const body = f.issue.body.split('\n').filter((l) => l.trim() !== '');
  const lines = [
    `Request #${String(f.issue.number)}: ${f.issue.title}`,
    ...body.slice(0, 5).map((l) => `> ${l}`),
  ];
  if (body.length > 5) lines.push(`> … ${String(body.length - 5)} more lines on the issue`);
  if (f.waives !== undefined)
    lines.push(`Waives ${f.waives}${f.head ? ` for PR head ${f.head.slice(0, 12)}` : ''}`);
  const spec = f.files?.spec;
  if (spec !== undefined && f.gate !== 'approved')
    for (const name of ['Problem', 'Affected areas'])
      lines.push(`${name}: ${specSection(spec, name).join('; ') || '(none given)'}`);
  return lines;
}

function mapping(f: SummaryFacts): Part {
  if (f.branch === undefined) return ['Not a work item: no spec applies'];
  if (f.gate === 'approved') {
    const lines = [`No spec yet: Specify writes it on ${f.branch}`];
    if (f.tier === 1)
      lines.push('tier 1: the spec is not approved separately; you see it next at merge');
    return lines;
  }
  const { spec, tasks } = f.files ?? {};
  if (spec === undefined)
    return f.gate === 'spec-approved'
      ? { missing: `no spec.md on ${f.branch}` }
      : [`No spec.md on ${f.branch} yet`];
  const { acs } = checkSpec(spec);
  if (acs.length === 0) return { missing: 'spec.md defines no acceptance criteria' };
  const testTasks = parseTasks(tasks ?? '').filter((t) => t.test);
  return acs.map((ac) => {
    const ids = testTasks.filter((t) => new RegExp(`\\b${ac}\\b`).test(t.text)).map((t) => t.id);
    return `${ac} → ${ids.length > 0 ? ids.join(', ') : 'no test task yet'}`;
  });
}

function results(f: SummaryFacts): Part {
  const report = f.files?.verify;
  if (report !== undefined) {
    const r = checkVerifyReport(report);
    return r.complete ? ['reports/verify.md: all checks pass'] : r.missing;
  }
  if (f.branch === undefined) return ['Not a work item: no tests or review apply'];
  if (f.gate !== 'waiver') return ['None yet: this gate comes before Build'];
  return [`No reports/verify.md on ${f.branch} yet`];
}

function usage(f: SummaryFacts): Part {
  if (f.branch === undefined) return ['Not a work item: no usage logged'];
  if (f.gate === 'approved') return ['None logged yet: events start on the item branch'];
  const events = f.files?.events;
  if (events === undefined) return [`No events.jsonl on ${f.branch} yet: no usage logged`];
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
  const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`;
  const lines = [
    `${plural(sessions, 'session')}, about ${String(Math.round(share * 100))}% of the plan's usage, from ${plural(counted, 'usage event')} in events.jsonl (telemetry, unverified)`,
  ];
  if (unreadable > 0) lines.push(`${plural(unreadable, 'unreadable line')} not counted`);
  return lines;
}

function risks(f: SummaryFacts): Part {
  const noted = f.issue.labels.filter((l) => /^(?:type:|priority:|security$)/.test(l));
  const labels = noted.length > 0 ? ` (${noted.join(', ')})` : '';
  if (f.branch === undefined) {
    const target = f.waives ?? '';
    const what = target.startsWith('finding:') ? ': the finding stays unfixed' : '';
    return [`Waiver of ${target} on #${String(f.issue.number)}${what}${labels}`];
  }
  if (f.tier === undefined) return { missing: 'no confirmed tier' };
  const lines = [`Tier ${String(f.tier)}${labels}`];
  const spec = f.files?.spec;
  if (spec === undefined) {
    if (f.tier === 3) lines.push('tier 3: the spec must add a Risks section');
    return lines;
  }
  const listed = specSection(spec, 'Risks');
  if (listed.length === 0 && f.tier === 3)
    return { missing: 'tier 3 needs a Risks section in spec.md' };
  return [...lines, ...listed];
}

const PARTS: Readonly<Record<SummaryPart, (f: SummaryFacts) => Part>> = {
  changed,
  mapping,
  results,
  usage,
  risks,
};

/** The summary to show before signing, or every part that cannot be given. */
export function buildSummary(facts: SummaryFacts): Summary {
  const out: string[] = [];
  const missing: string[] = [];
  for (const [key, title] of Object.entries(PART_TITLES)) {
    const part = PARTS[key as SummaryPart](facts);
    if (Array.isArray(part) && part.length > 0)
      out.push(title, ...part.map((l) => `  ${clean(l)}`));
    else missing.push(`${title}: ${Array.isArray(part) ? 'nothing to show' : part.missing}`);
  }
  if (missing.length > 0) return { ok: false, missing };
  const head = `Approval summary for #${String(facts.issue.number)} (${facts.gate}):`;
  return { ok: true, text: `${clean(head)}\n\n${out.join('\n')}\n` };
}
