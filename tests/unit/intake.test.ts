import { describe, expect, it } from 'vitest';
import { FACTORY_LABELS } from '../../src/install/labels.js';
import { ITEM_TYPES } from '../../src/model/types.js';
import {
  checkIntake,
  checkIntakeIssue,
  duplicateOf,
  type IntakeIssue,
} from '../../src/stations/checks/intake.js';
import { seedState } from '../helpers/fake-gh.js';

const REPO = 'owner/project';
const LABELS = ['owner:approved', 'type:feature', 'priority:p2', 'tier:2'];

const issue = (over: Partial<IntakeIssue> = {}): IntakeIssue => ({
  number: 7,
  state: 'OPEN',
  labels: LABELS,
  comments: [],
  ...over,
});

const missing = (i: IntakeIssue) => checkIntake(i).missing.join('\n');

describe('Intake output check: type, priority and tier (AC-009)', () => {
  it('AC-009: an admitted item with one type, one priority and one proposed tier is triaged', () => {
    expect(checkIntake(issue())).toEqual({
      complete: true,
      missing: [],
      type: 'feature',
      priority: 'p2',
      tier: 2,
    });
  });

  it.each(ITEM_TYPES)('AC-009: accepts type:%s', (type) => {
    const labels = [`type:${type}`, 'priority:p0', 'tier:1'];
    expect(checkIntake(issue({ labels })).type).toBe(type);
  });

  it.each([
    ['no type', ['priority:p2', 'tier:2'], /no type: label/],
    ['two types', ['type:bug', 'type:debt', 'priority:p2', 'tier:2'], /2 type: labels/],
    ['an unknown type', ['type:chore', 'priority:p2', 'tier:2'], /type:chore is not a type/],
    ['no priority', ['type:bug', 'tier:2'], /no priority: label/],
    ['two priorities', ['type:bug', 'priority:p1', 'priority:p2', 'tier:2'], /2 priority:/],
    ['priority p4', ['type:bug', 'priority:p4', 'tier:2'], /priority:p4 is not p0–p3/],
    ['no tier', ['type:bug', 'priority:p2'], /no tier: label/],
    ['two tiers', ['type:bug', 'priority:p2', 'tier:1', 'tier:3'], /2 tier: labels/],
    ['tier 4', ['type:bug', 'priority:p2', 'tier:4'], /tier:4 is not 1–3/],
  ])('AC-009: refuses %s', (_name, labels, why) => {
    const result = checkIntake(issue({ labels }));
    expect(result.complete).toBe(false);
    expect(result.missing.join('\n')).toMatch(why);
  });

  it('AC-009: an item closed without a duplicate-of comment is not triaged', () => {
    expect(missing(issue({ state: 'CLOSED' }))).toMatch(/closed without a duplicate-of comment/);
  });

  it('AC-009: the install step creates every type: and priority: label Intake applies', () => {
    const names = FACTORY_LABELS.map((l) => l.name);
    for (const type of ITEM_TYPES) expect(names).toContain(`type:${type}`);
    for (const p of ['p0', 'p1', 'p2', 'p3']) expect(names).toContain(`priority:${p}`);
  });
});

describe('Intake output check: duplicates (AC-009)', () => {
  const marked = (n: number) => ({
    body: `Same as #${String(n)}.\n<!-- duplicate-of #${String(n)} -->`,
  });

  it('AC-009: reads the duplicate-of marker from a comment', () => {
    expect(duplicateOf(marked(3).body)).toBe(3);
    expect(duplicateOf('see #3')).toBeUndefined();
  });

  it('AC-009: a duplicate closed with a duplicate-of comment is done and does not enter the line', () => {
    const result = checkIntake(issue({ state: 'CLOSED', labels: [], comments: [marked(3)] }));
    expect(result).toEqual({ complete: true, missing: [], duplicateOf: 3 });
  });

  it('AC-009: a duplicate left open is not done', () => {
    const result = checkIntake(issue({ labels: [], comments: [marked(3)] }));
    expect(result.complete).toBe(false);
    expect(result.missing.join('\n')).toMatch(/duplicate of #3 but still open; close it/);
  });

  it('AC-009: an item cannot be a duplicate of itself', () => {
    expect(missing(issue({ state: 'CLOSED', comments: [marked(7)] }))).toMatch(/of itself/);
  });

  it('AC-009: two different duplicate-of markers are refused', () => {
    const comments = [marked(3), marked(4)];
    expect(missing(issue({ state: 'CLOSED', comments }))).toMatch(/#3 and #4/);
  });
});

describe('Intake output check against GitHub (AC-009)', () => {
  const seed = (issues: Parameters<typeof seedState>[0]) => seedState(issues);

  it('AC-009: reads the item from GitHub and checks it', async () => {
    seed({ repos: { [REPO]: { issues: [{ number: 7, title: 'Add login', labels: LABELS }] } } });
    expect(await checkIntakeIssue(REPO, 7)).toMatchObject({ complete: true, tier: 2 });
  });

  it('AC-009: a duplicate must name an existing issue', async () => {
    const comments = [
      {
        id: 1,
        author: 'owner',
        body: '<!-- duplicate-of #99 -->',
        createdAt: '2026-10-05T08:00:00Z',
      },
    ];
    seed({
      repos: { [REPO]: { issues: [{ number: 7, title: 'Add login', state: 'CLOSED', comments }] } },
    });
    const result = await checkIntakeIssue(REPO, 7);
    expect(result.complete).toBe(false);
    expect(result.missing.join('\n')).toMatch(/#99: no such issue/);
  });

  it('AC-009: a duplicate of an existing issue passes', async () => {
    const comments = [
      {
        id: 1,
        author: 'owner',
        body: '<!-- duplicate-of #3 -->',
        createdAt: '2026-10-05T08:00:00Z',
      },
    ];
    seed({
      repos: {
        [REPO]: {
          issues: [
            { number: 3, title: 'Login' },
            { number: 7, title: 'Add login', state: 'CLOSED', comments },
          ],
        },
      },
    });
    expect(await checkIntakeIssue(REPO, 7)).toMatchObject({ complete: true, duplicateOf: 3 });
  });
});
