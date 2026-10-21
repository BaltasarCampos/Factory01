// Contract tests for the station prompts (T072; Owner decisions 2026-10-20, after T124): each is
// rendered from the release's `factory/prompts/`, carrying the steps of the commands its station
// runs, in order, read from `factory/skills/<command>/SKILL.md`, so it leaves no command for the
// session to find or call.
import { describe, expect, it } from 'vitest';
import {
  QUESTIONS_OPEN,
  STATION_COMMANDS,
  stationPrompt,
  type PromptFacts,
  type ReleaseFile,
} from '../../src/dispatcher/prompts.js';
import type { Station } from '../../src/model/types.js';
import { workingRelease as release } from '../helpers/release.js';

const ITEM: PromptFacts = {
  station: 2,
  repo: 'owner/project',
  issue: 42,
  title: 'Add login',
  body: 'Visitors sign in with their email address.',
  branch: 'claude/42-add-login',
  itemBranch: 'claude/42-add-login',
  tier: 1,
};
const BRANCH: Record<Station, string> = {
  0: 'claude/define',
  1: 'main',
  2: ITEM.branch,
  3: ITEM.branch,
  4: ITEM.branch,
  5: ITEM.branch,
  6: ITEM.branch,
  7: 'claude/factory-log',
  8: 'claude/factory-log',
};
const render = (station: Station, over: Partial<PromptFacts> = {}) =>
  stationPrompt(release, {
    ...ITEM,
    station,
    branch: BRANCH[station],
    changed: ['src/login.ts', 'tests/login.test.ts'],
    range: `${'a'.repeat(40)}..origin/main`,
    ...over,
  });
const STATIONS: Station[] = [1, 2, 3, 4, 5, 6, 7, 8];
const headings = (text: string) => [...text.matchAll(/^## Step \d+: (.+)$/gm)].map((m) => m[1]);

describe('station prompts (T072)', () => {
  it.each(STATIONS)('station %i: renders with every placeholder filled', (station) => {
    const text = render(station);
    expect(text).not.toMatch(/\{\{|\$ARGUMENTS|^---$/m);
    expect(text).toMatch(new RegExp(`^Station ${String(station)} \\(`));
  });

  it.each(STATIONS)('station %i: leaves no /speckit-* command for the session to call', (s) => {
    expect(render(s)).not.toMatch(/\/speckit-/);
  });

  it('carries each station’s commands in order: specify; plan, tasks, analyze and the fix; implement', () => {
    expect(headings(render(2))).toEqual(['speckit-specify']);
    expect(headings(render(3))).toEqual([
      'speckit-plan',
      'speckit-tasks',
      'speckit-analyze',
      'fix the analysis findings',
    ]);
    expect(headings(render(4))).toEqual(['speckit-implement']);
    for (const station of [1, 5, 6, 7, 8] as const) expect(headings(render(station))).toEqual([]);
    expect(STATION_COMMANDS[3]).toEqual(['speckit-plan', 'speckit-tasks', 'speckit-analyze']);
  });

  it('each step after the first starts by ending the session on open questions', () => {
    const steps = render(3)
      .split(/^## Step \d+: .+$/m)
      .slice(1);
    expect(steps).toHaveLength(4);
    expect(steps[0]?.trim().startsWith(QUESTIONS_OPEN)).toBe(false);
    for (const step of steps.slice(1)) expect(step.trim().startsWith(QUESTIONS_OPEN)).toBe(true);
  });

  it('station 3’s steps finish without ending the session; only its last step ends it', () => {
    const steps = render(3)
      .split(/^## Step \d+: .+$/m)
      .slice(1);
    for (const step of steps.slice(0, -1)) expect(step).not.toMatch(/end your\s+session with/i);
    expect(steps.at(-1)).toMatch(/Then end your\s+session\s+with one short message/);
  });

  it('puts the command’s own steps in the prompt, frontmatter dropped, headings one level down', () => {
    const text = render(2);
    expect(text).not.toContain('user-invocable');
    expect(text).toContain('### Where you work');
    expect(text).toContain('feature folder your station prompt names');
  });

  it.each([2, 3, 4, 5, 6] as const)('station %i: names its feature folder and branch', (s) => {
    expect(render(s)).toContain(
      'Feature folder: specs/42-add-login/ on the branch `claude/42-add-login`',
    );
  });

  it('station 2: the work item is the command’s input; stations 3 and 4 get its number and title', () => {
    expect(render(2)).toContain('#42 Add login\n\nVisitors sign in with their email address.');
    expect(render(2)).toMatch(/work item #42, tier 1\./);
    expect(render(3)).toContain('#42 Add login\n```');
    expect(render(4)).not.toContain('Visitors sign in');
  });

  it('fills placeholders once: text from the issue is never expanded again', () => {
    const text = render(2, {
      title: 'Add {{repo}} login $ARGUMENTS',
      body: 'Body with {{commands}} and ‮hidden\u0007 text.',
    });
    expect(text).toContain('#42 Add {{repo}} login $ARGUMENTS');
    expect(text).toContain('Body with {{commands}} and hidden text.');
    expect(text.match(/^## Step /gm)).toHaveLength(1);
  });

  it('stations 1, 7 and 8: Intake pushes nothing; Release and Operate work on claude/factory-log', () => {
    expect(render(1)).toMatch(/Push nothing and write no file/);
    for (const station of [7, 8] as const)
      expect(render(station)).toContain('on the branch `claude/factory-log`');
  });

  it('station 5 lists the files the pull request changes and names both Verify reports', () => {
    const text = render(5, { changed: ['src/a.ts', 'src/odd‮name.ts'] });
    expect(text).toContain('- src/a.ts\n- src/odd\\u{202e}name.ts');
    expect(text).toContain('specs/42-add-login/reports/verify.md');
    expect(text).toContain('specs/42-add-login/reports/security.md');
    expect(render(5, { changed: [] })).toContain('- none');
  });

  it('station 6 names reports/integrate.md and sends a conflict back to Build', () => {
    expect(render(6)).toContain('specs/42-add-login/reports/integrate.md');
    expect(render(6)).toMatch(/A conflict goes back to Build/);
  });

  it('station 7 gives the range since the last deploy and names the new release note', () => {
    const text = render(7);
    expect(text).toContain(`\`${'a'.repeat(40)}..origin/main\``);
    expect(text).toContain('`.factory/releases/42-add-login.md`');
  });

  it('every prompt asks for the result before the session ends or waits on the Owner', () => {
    for (const station of STATIONS)
      expect(render(station)).toMatch(
        /before you\s+end\s+your\s+session\s+or\s+wait\s+on\s+the\s+Owner/,
      );
  });

  it('refuses a template naming a placeholder it has no value for, or a missing file', () => {
    const broken: ReleaseFile = (path) =>
      path.startsWith('prompts/') ? 'Station 6 for {{nobody}}.\n' : release(path);
    expect(() => stationPrompt(broken, { ...ITEM, station: 6 })).toThrow(/\{\{nobody\}\}/);
    const missing: ReleaseFile = () => {
      throw new Error('no such file');
    };
    expect(() => stationPrompt(missing, ITEM)).toThrow(/no such file/);
  });
});
