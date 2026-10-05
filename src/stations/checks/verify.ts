// Verify output check (AC-013; data-model.md § State machine, verifying → integrating).
// `specs/<feature>/reports/verify.md` has one table row per check, `| <Check> | <result> | … |`,
// for CI, Coverage, SAST, SCA, Secrets, Licences and Review; only `pass` passes. Blocking review
// findings are task items, `- [ ] blocking: …` until resolved and `- [x] …` after; they may also
// sit under a `## Blocking findings` heading. Any failing line keeps the item in `verifying`.
import type { CheckResult } from '../../hooks/stop.js';
import { featureFiles } from './feature.js';

export const VERIFY_CHECKS = [
  'CI',
  'Coverage',
  'SAST',
  'SCA',
  'Secrets',
  'Licences',
  'Review',
] as const;

const REPORT = 'reports/verify.md';
const ALIASES: Record<string, string> = { licenses: 'licences' };

export interface VerifyResult extends CheckResult {
  missing: string[];
  /** Every check is listed once and passes. */
  checksPass: boolean;
  /** No blocking finding is open. */
  findingsResolved: boolean;
}

export function checkVerifyReport(text: string): VerifyResult {
  const results = new Map<string, string[]>();
  const open: string[] = [];
  let blockingSection = false;
  for (const line of text.split('\n')) {
    if (/^#+\s/.test(line)) blockingSection = /^#+\s+Blocking findings\b/i.test(line);
    const row = /^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/.exec(line);
    if (row) {
      const name = (row[1] ?? '').toLowerCase();
      const key = ALIASES[name] ?? name;
      results.set(key, [...(results.get(key) ?? []), (row[2] ?? '').toLowerCase()]);
    }
    const item = /^\s*- \[ \]\s+(.*)$/.exec(line)?.[1];
    if (item === undefined) continue;
    const blocking = /^blocking:\s*/i.exec(item);
    if (blocking || blockingSection) open.push(item.slice(blocking?.[0].length ?? 0));
  }

  const failing: string[] = [];
  for (const check of VERIFY_CHECKS) {
    const listed = results.get(check.toLowerCase()) ?? [];
    if (listed.length === 0) failing.push(`${REPORT}: no ${check} line`);
    else if (listed.length > 1)
      failing.push(`${REPORT}: ${check}: listed ${String(listed.length)} times`);
    else if (listed[0] !== 'pass') failing.push(`${REPORT}: ${check}: ${listed[0] || 'no result'}`);
  }
  const missing = [...failing, ...open.map((f) => `${REPORT}: unresolved blocking finding: ${f}`)];
  return {
    complete: missing.length === 0,
    missing,
    checksPass: failing.length === 0,
    findingsResolved: open.length === 0,
  };
}

/** The stop hook's check for Verify: the committed report of the feature folder. */
export function verifyStopCheck(cwd: string): CheckResult {
  const files = featureFiles(cwd, [REPORT]);
  const report = files.text[REPORT];
  return report === undefined
    ? { complete: false, missing: files.missing }
    : checkVerifyReport(report);
}
