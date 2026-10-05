// Specify output check (FR-016a, AC-010): `spec.md` states the problem, the non-goals and the
// affected areas, and defines at least one acceptance criterion, each with an `AC-###` ID and
// testable as Given/When/Then. A section is a heading (`## Problem`) or, in a tier 1 one-line
// spec, a labelled line (`**Problem**: …`). Template placeholders and comments are not content.
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
const meaningful = (line: string) => {
  const text = line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim();
  return text !== '' && !/^\[[^\]]*\]$/.test(text);
};

/** The section's content lines, or undefined when the spec has no such section. */
function section(lines: readonly string[], name: string): string[] | undefined {
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

export function checkSpec(text: string): SpecResult {
  const lines = text.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const missing: string[] = [];
  for (const name of SPEC_SECTIONS) {
    const content = section(lines, name);
    if (content === undefined) missing.push(`spec.md: no ${name} section`);
    else if (!content.some(meaningful)) missing.push(`spec.md: the ${name} section is empty`);
  }

  const defined = new Map<string, number>();
  for (const line of lines) {
    const m = /^\s*(?:[-*]|\d+\.)?\s*\*\*(AC-\d+)\*\*(.*)$/.exec(line);
    if (!m) continue;
    const [, id = '', rest = ''] = m;
    defined.set(id, (defined.get(id) ?? 0) + 1);
    if (!/\bGiven\b[\s\S]*\bWhen\b[\s\S]*\bThen\b/.test(rest))
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
