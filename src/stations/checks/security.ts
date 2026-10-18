// Security's output check (T168; design § Tools and permissions): `specs/<feature>/reports/
// security.md`, the only file Security writes. Its scanner runs are triage, so the check asks
// only that it lists them, as list items under `## Scans`, and words its findings under
// `## Findings`: each blocking one `- [ ] blocking: <rule> at <path:line>: <why>` until a re-scan
// shows it gone, then `- [x] …`. Any unchecked item under `## Findings`, or anywhere worded
// `blocking:`, is open, and an open one keeps the item in `verifying`; a dismissal is the Owner's
// (T105).
import type { CheckResult } from '../../hooks/stop.js';
import { featureFiles } from './feature.js';

const REPORT = 'reports/security.md';

export interface SecurityResult extends CheckResult {
  missing: string[];
  /** No blocking finding is open. */
  findingsResolved: boolean;
  /** The open blocking findings, as the report words them. */
  open: string[];
}

export function checkSecurityReport(text: string): SecurityResult {
  const open: string[] = [];
  let section = '';
  let scans = 0;
  let findings = false;
  for (const line of text.split('\n')) {
    const heading = /^#+\s+(.*?)\s*$/.exec(line)?.[1];
    if (heading !== undefined) {
      section = heading.toLowerCase();
      findings ||= section === 'findings';
      continue;
    }
    if (section === 'scans' && /^\s*[-*]\s+\S/.test(line)) scans += 1;
    const item = /^\s*- \[ \]\s+(.*)$/.exec(line)?.[1];
    if (item === undefined) continue;
    const blocking = /^blocking:\s*/i.exec(item);
    if (blocking || section === 'findings') open.push(item.slice(blocking?.[0].length ?? 0));
  }

  const missing = [
    ...(scans === 0 ? [`${REPORT}: no scans listed under ## Scans`] : []),
    ...(findings ? [] : [`${REPORT}: no ## Findings section`]),
    ...open.map((f) => `${REPORT}: unresolved blocking finding: ${f}`),
  ];
  return { complete: missing.length === 0, missing, findingsResolved: open.length === 0, open };
}

/** The stop hook's check for Security's session: the committed report of the feature folder. */
export function securityStopCheck(cwd: string): CheckResult {
  const files = featureFiles(cwd, [REPORT]);
  const report = files.text[REPORT];
  return report === undefined
    ? { complete: false, missing: files.missing }
    : checkSecurityReport(report);
}
