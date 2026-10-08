// Guardrail fixtures: hook settings a factory release would install, and a release manifest.
import { createHash } from 'node:crypto';
import type { GuardrailManifest } from '../../src/model/types.js';

/** `.claude/settings.json` registering every factory hook. */
export const HOOKED_SETTINGS = `${JSON.stringify({
  hooks: Object.fromEntries(
    ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact'].map((event) => [
      event,
      [{ hooks: [{ type: 'command', command: `factory hook ${event}` }] }],
    ]),
  ),
})}\n`;

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
