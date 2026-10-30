// Guardrail fixtures: hook settings a factory release would install, and a release manifest.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GuardrailManifest } from '../../src/model/types.js';

/** `.claude/settings.json` registering every factory hook: the installed factory's own. */
export const HOOKED_SETTINGS = readFileSync(
  new URL('../../factory/settings/settings.json', import.meta.url),
  'utf8',
);

/** Stand-ins for the programs Claude Code's sandbox needs, for a launch test's PATH. */
export const SANDBOX_BIN = realpathSync(fileURLToPath(new URL('./sandbox-bin', import.meta.url)));

/**
 * What the launcher's shell check reads from a shell with no functions or aliases: only its end
 * line, the last word of the check's command.
 */
export const quietShell = (args: readonly string[]) => ({
  status: 0,
  stdout: `${args[1]?.split(' ').at(-1) ?? ''}\n`,
  stderr: '',
});

/** A release manifest listing these files with their hashes. */
export const manifestOf = (files: Record<string, string>): GuardrailManifest => ({
  release: 'v1.0.0',
  commit: 'a'.repeat(40),
  files: Object.fromEntries(
    Object.entries(files).map(([path, text]) => [
      path,
      createHash('sha256').update(text).digest('hex'),
    ]),
  ),
});
