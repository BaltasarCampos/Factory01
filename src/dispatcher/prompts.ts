// Station prompts (T072; Owner decisions 2026-10-20, after T124): rendered from the pinned
// release's `factory/prompts/`, each carrying the steps of the commands its station runs, in
// order. A command's steps are its `factory/skills/<command>/SKILL.md` with the frontmatter
// dropped and the station's input where `$ARGUMENTS` stands. No role has the Skill tool, so
// nothing depends on a session finding or choosing a command, and the local and cloud launchers
// send the same text. Placeholders are filled in one pass, so text from the issue is never
// expanded again.
import { spawnSync } from 'node:child_process';
import { RefusedError } from '../cli/env.js';
import { branchFeatureDir } from '../model/naming.js';
import type { Station, Tier } from '../model/types.js';
import { clean, visible } from '../notify/summary.js';

/** A file of the release, by its path under `factory/`. */
export type ReleaseFile = (path: string) => string;

/** The release pinned at `sha`, read from git objects in the factory clone, never a checkout. */
export function pinnedRelease(factory: string, sha: string, env = process.env): ReleaseFile {
  return (path) => {
    const shown = spawnSync('git', ['show', `${sha}:factory/${path}`], {
      cwd: factory,
      env,
      encoding: 'utf8',
    });
    if (shown.error !== undefined || shown.status !== 0)
      throw new RefusedError(`the release pinned at ${sha.slice(0, 12)} has no factory/${path}`);
    return shown.stdout;
  };
}

const PROMPT_FILES: Readonly<Record<Station, string>> = {
  0: 'station-0-define.md',
  1: 'station-1-intake.md',
  2: 'station-2-specify.md',
  3: 'station-3-plan.md',
  4: 'station-4-build.md',
  5: 'station-5-verify.md',
  6: 'station-6-integrate.md',
  7: 'station-7-release.md',
  8: 'station-8-operate.md',
};

/** The commands each station runs, in order; station 3's prompt then fixes analyze's findings. */
export const STATION_COMMANDS: Readonly<Partial<Record<Station, readonly string[]>>> = {
  2: ['speckit-specify'],
  3: ['speckit-plan', 'speckit-tasks', 'speckit-analyze'],
  4: ['speckit-implement'],
};

/** How every step after the first begins. */
export const QUESTIONS_OPEN = 'If the previous step left questions open, end your session.';

export interface PromptFacts {
  station: Station;
  repo: string;
  issue: number;
  title: string;
  body: string;
  /** The branch the session works on. */
  branch: string;
  /** The item's branch, `claude/<issue>-<slug>`, which names its feature folder. */
  itemBranch?: string;
  tier?: Tier;
  /** Verify: the files the pull request changes. */
  changed?: readonly string[];
  /** Release: main's commits since the last deploy, as a git range. */
  range?: string;
}

/** A command's steps: no frontmatter, headings one level down, `input` for `$ARGUMENTS`. */
function commandSteps(text: string, input: string): string {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^(#+) /gm, '#$1 ');
  return body.split('$ARGUMENTS').join(input).trim();
}

function fill(template: string, vars: Readonly<Record<string, string>>, path: string): string {
  return template.replace(/\{\{([a-z]+)\}\}/g, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new RefusedError(`factory/${path}: no value for {{${name}}}`);
    return value;
  });
}

export function stationPrompt(read: ReleaseFile, f: PromptFacts): string {
  const title = clean(f.title).replace(/\s+/g, ' ').trim();
  const item = `#${String(f.issue)} ${title}`;
  const input = f.station === 2 ? `${item}\n\n${clean(f.body).trim()}` : item;
  const commands = (STATION_COMMANDS[f.station] ?? []).map((name, i) => {
    const steps = commandSteps(read(`skills/${name}/SKILL.md`), input);
    return `## Step ${String(i + 1)}: ${name}\n\n${i === 0 ? '' : `${QUESTIONS_OPEN}\n\n`}${steps}`;
  });
  const feature = branchFeatureDir(f.itemBranch ?? f.branch) ?? '';
  const changed = (f.changed ?? []).map((path) => `- ${visible(path)}`);
  const path = `prompts/${PROMPT_FILES[f.station]}`;
  const vars = {
    repo: f.repo,
    issue: String(f.issue),
    title,
    tier: f.tier === undefined ? 'not confirmed' : String(f.tier),
    branch: f.branch,
    feature,
    changed: changed.length > 0 ? changed.join('\n') : '- none',
    range: f.range ?? 'origin/main',
    note: `.factory/releases/${feature.slice('specs/'.length)}.md`,
    commands: commands.join('\n\n'),
  };
  return `${fill(read(path), vars, path).trim()}\n`;
}
