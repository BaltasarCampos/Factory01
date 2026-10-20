// The release's prompts and commands as this checkout holds them, for tests that render or
// launch station prompts (src/dispatcher/prompts.ts).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stationPrompt, type PromptFacts, type ReleaseFile } from '../../src/dispatcher/prompts.js';

const FACTORY = fileURLToPath(new URL('../../factory', import.meta.url));

export const workingRelease: ReleaseFile = (path) => readFileSync(join(FACTORY, path), 'utf8');

/** `DispatchContext.stationPrompt` over this checkout's release, whatever the pin. */
export const testPrompts = (_pin: string, facts: PromptFacts) =>
  stationPrompt(workingRelease, facts);

/** `factory/prompts/**` and `factory/skills/**`, keyed by repository path, for a factory repo. */
export function promptFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(join(FACTORY, 'prompts')))
    files[`factory/prompts/${name}`] = workingRelease(`prompts/${name}`);
  for (const name of readdirSync(join(FACTORY, 'skills')))
    files[`factory/skills/${name}/SKILL.md`] = workingRelease(`skills/${name}/SKILL.md`);
  return files;
}
