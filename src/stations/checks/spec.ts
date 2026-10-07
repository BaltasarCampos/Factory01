// Specify output check (FR-016a, AC-010): `spec.md` states the problem, the non-goals and the
// affected areas, and defines at least one acceptance criterion, each with an `AC-###` ID and
// testable as Given/When/Then. A section is a heading (`## Problem`) or, in a tier 1 one-line
// spec, a labelled line (`**Problem**: …`). Template placeholders and comments are not content.
//
// Criterion lines (FR-042, AC-097) are read by one parser, `criterionLines`, which the Specify
// check uses and `ac-map` and `red-green` will use: every list item under Acceptance Scenarios or
// Edge Cases, whatever its wording, and, anywhere else, a line with two or more of a capitalised
// Given, When or Then, or one of them in bold, plus any line that starts with an ID. Each must
// start with exactly one `**AC-###**`. Lowercase "when … then" prose is not a criterion line.
import type { CheckResult } from '../../hooks/stop.js';
import { featureFiles } from './feature.js';

export const SPEC_SECTIONS = ['Problem', 'Non-goals', 'Affected areas'] as const;

export interface SpecResult extends CheckResult {
  missing: string[];
  /** Acceptance criterion IDs defined in the spec, in order. */
  acs: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A line that says something: not blank and not a `[placeholder]`. */
export const meaningful = (line: string) => {
  const text = line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim();
  return text !== '' && !/^\[[^\]]*\]$/.test(text);
};

/** The section's content lines, or undefined when the spec has no such section. */
export function section(lines: readonly string[], name: string): string[] | undefined {
  const heading = new RegExp(`^(#{2,})\\s+${escape(name)}\\b`, 'i');
  const labelled = new RegExp(`^\\*\\*${escape(name)}:?\\*\\*:?(.*)$`, 'i');
  for (const [i, line] of lines.entries()) {
    const label = labelled.exec(line);
    if (label) return [label[1] ?? ''];
    const level = heading.exec(line)?.[1]?.length;
    if (level === undefined) continue;
    const rest = lines.slice(i + 1);
    const end = rest.findIndex((l) => {
      const next = /^(#+)\s/.exec(l)?.[1]?.length;
      return next !== undefined && next <= level;
    });
    return end === -1 ? rest : rest.slice(0, end);
  }
  return undefined;
}

export interface CriterionLine {
  /** 1-based line number in `spec.md`. */
  line: number;
  /** The leading `**AC-###**`, when the line has exactly one. */
  id?: string;
  problem?: string;
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const REGION = /^(?:#+\s+|\*\*)(?:Acceptance Scenarios|Edge Cases)\b/i;
const REGION_END = /^(?:#+\s|\*\*[^*]+\*\*:|---|\*\*\*\s*$|___)/;
const LEADING_ID = /^\*\*(AC-\d+)\*\*(?![\w*-])/;
const BOLD_ID = /\*\*AC-\d+\*\*/g;
const KEYWORDS = ['Given', 'When', 'Then'].map((k) => new RegExp(`\\b${k}\\b`));
const BOLD_KEYWORD = /\*\*(?:Given|When|Then)\b/i;

/** Comments blanked, keeping line numbers. */
const uncommented = (text: string) =>
  text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, '')).split('\n');

/** Every criterion line of a spec, with its ID or what is wrong with it. */
export function criterionLines(text: string): CriterionLine[] {
  let region = false;
  return uncommented(text).flatMap((raw, i): CriterionLine[] => {
    const line = raw.trim();
    if (REGION.test(line)) {
      region = true;
      return [];
    }
    if (REGION_END.test(line)) region = false;
    const item = LIST_ITEM.exec(raw);
    const body = item ? raw.slice(item[0].length).trim() : line;
    const keywords = KEYWORDS.filter((k) => k.test(body)).length;
    const lead = LEADING_ID.exec(body)?.[1];
    const ids = body.match(BOLD_ID)?.length ?? 0;
    const criterion = (region && item) || keywords >= 2 || BOLD_KEYWORD.test(body);
    if (!criterion && lead === undefined && !/^\*\*AC-/.test(body)) return [];
    const at = { line: i + 1 };
    if (lead === undefined)
      return [{ ...at, problem: 'criterion line without a leading **AC-###** ID' }];
    if (ids > 1)
      return [{ ...at, problem: `criterion line with ${String(ids)} **AC-###** IDs; exactly one` }];
    return [{ ...at, id: lead }];
  });
}

export function checkSpec(text: string): SpecResult {
  const lines = uncommented(text);
  const missing: string[] = [];
  for (const name of SPEC_SECTIONS) {
    const content = section(lines, name);
    if (content === undefined) missing.push(`spec.md: no ${name} section`);
    else if (!content.some(meaningful)) missing.push(`spec.md: the ${name} section is empty`);
  }

  const defined = new Map<string, number>();
  for (const { line, id, problem } of criterionLines(text)) {
    if (id === undefined) {
      missing.push(`spec.md:${String(line)}: ${problem ?? ''}`);
      continue;
    }
    defined.set(id, (defined.get(id) ?? 0) + 1);
    if (!/\bGiven\b[\s\S]*\bWhen\b[\s\S]*\bThen\b/.test(lines[line - 1] ?? ''))
      missing.push(`spec.md: ${id} has no Given/When/Then`);
  }
  if (defined.size === 0) missing.push('spec.md: no acceptance criteria (**AC-###** lines)');
  for (const [id, count] of defined)
    if (count > 1)
      missing.push(`spec.md: ${id} is defined ${count === 2 ? 'twice' : `${String(count)} times`}`);
  return { complete: missing.length === 0, missing, acs: [...defined.keys()] };
}

/** The stop hook's check for Specify: the committed `spec.md` of the feature folder. */
export function specStopCheck(cwd: string): CheckResult {
  const files = featureFiles(cwd, ['spec.md']);
  const spec = files.text['spec.md'];
  return spec === undefined ? { complete: false, missing: files.missing } : checkSpec(spec);
}
