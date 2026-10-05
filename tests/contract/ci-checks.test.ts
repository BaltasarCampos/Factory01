// T051, Verify report part (slice 14). The `factory ci coverage`, `size` and `ac-map` cases
// arrive with slice 18b.
import { describe, expect, it } from 'vitest';
import { checkVerifyReport, VERIFY_CHECKS } from '../../src/stations/checks/verify.js';

const ROWS = {
  CI: 'pass | run 812 green on 3f9a0c1',
  Coverage: 'pass | 94.2% of changed lines',
  SAST: 'pass | semgrep: 0 new findings',
  SCA: 'pass | npm audit: 0 at or above high',
  Secrets: 'pass | gitleaks: none',
  Licences: 'pass | all on the allowed list',
  Review: 'pass | 2 findings, both resolved',
};

function report(
  rows: Record<string, string> = ROWS,
  findings = '- [x] blocking: lockout never resets (fixed in 9c1e2d0)\n- non-blocking: rename `tries`\n',
) {
  const table = Object.entries(rows)
    .map(([check, rest]) => `| ${check} | ${rest} |`)
    .join('\n');
  return `# Verify report: #42 Add login\n\n| Check | Result | Evidence |\n|-------|--------|----------|\n${table}\n\n## Blocking findings\n\n${findings}`;
}

const why = (text: string) => checkVerifyReport(text).missing.join('\n');

describe('Verify report check (AC-013)', () => {
  it('AC-013: a report with every check passing and blocking findings resolved lets the item move on', () => {
    expect(checkVerifyReport(report())).toEqual({
      complete: true,
      missing: [],
      checksPass: true,
      findingsResolved: true,
    });
  });

  it('AC-013: the report must list CI, coverage, SAST, SCA, secrets, licences and review', () => {
    expect([...VERIFY_CHECKS]).toEqual([
      'CI',
      'Coverage',
      'SAST',
      'SCA',
      'Secrets',
      'Licences',
      'Review',
    ]);
  });

  it.each(Object.keys(ROWS))('AC-013: a report without %s blocks the item', (check) => {
    const rows = Object.fromEntries(Object.entries(ROWS).filter(([c]) => c !== check));
    const result = checkVerifyReport(report(rows));
    expect(result).toMatchObject({ complete: false, checksPass: false });
    expect(why(report(rows))).toMatch(new RegExp(`reports/verify.md: no ${check} line`));
  });

  it.each(Object.keys(ROWS))('AC-013: a failing %s line blocks the item', (check) => {
    const rows = { ...ROWS, [check]: 'fail | see the job log' };
    expect(checkVerifyReport(report(rows))).toMatchObject({ complete: false, checksPass: false });
    expect(why(report(rows))).toMatch(new RegExp(`${check}: fail`));
  });

  it('AC-013: anything other than pass counts as failing', () => {
    const rows = { ...ROWS, SAST: 'skipped | semgrep was not run' };
    expect(why(report(rows))).toMatch(/SAST: skipped/);
  });

  it('AC-013: a check listed twice with different results counts as failing', () => {
    const text = report().replace('| Review |', '| Coverage | fail | 88% |\n| Review |');
    expect(why(text)).toMatch(/Coverage: listed 2 times/);
  });

  it('AC-013: an unresolved blocking review finding blocks the item even when every check passes', () => {
    const text = report(ROWS, '- [ ] blocking: passwords are logged\n- [x] blocking: lockout\n');
    expect(checkVerifyReport(text)).toMatchObject({
      complete: false,
      checksPass: true,
      findingsResolved: false,
    });
    expect(why(text)).toMatch(/unresolved blocking finding: passwords are logged/);
  });

  it('AC-013: check names are matched without regard to case, and Licenses is accepted', () => {
    const rows = Object.fromEntries(
      Object.entries(ROWS).map(([c, r]) => [c === 'Licences' ? 'Licenses' : c.toLowerCase(), r]),
    );
    expect(checkVerifyReport(report(rows)).complete).toBe(true);
  });
});
