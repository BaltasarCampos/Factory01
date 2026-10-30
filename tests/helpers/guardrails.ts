// Guardrail fixtures: hook settings a factory release would install, and a release manifest.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sessionTools } from '../../src/dispatcher/launcher/local.js';
import type { GuardrailManifest, RoleName } from '../../src/model/types.js';

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

/** Changes to the init message and the result line a stand-in session prints. */
export interface StreamChange {
  init?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

/**
 * What `claude --output-format stream-json --verbose` prints for the launch `args`: an init
 * message that matches the launch, an assistant message and a result line, each as `change` says.
 */
export function sessionStream(args: readonly string[], change: StreamChange = {}): string {
  const at = (flag: string) => args[args.indexOf(flag) + 1] ?? '';
  const model = `claude-${at('--model')}-5-5`;
  const init = {
    ...{ type: 'system', subtype: 'init', session_id: at('--session-id') },
    tools: sessionTools(at('--agent') as RoleName),
    mcp_servers: [{ name: 'factory', status: 'connected' }],
    ...{ permissionMode: 'dontAsk', model, claude_code_version: '2.1.309' },
    ...change.init,
  };
  const result = {
    ...{ type: 'result', subtype: 'success', is_error: false, session_id: at('--session-id') },
    ...{ num_turns: 3, permission_denials: [], modelUsage: { [model]: {} } },
    ...change.result,
  };
  const assistant = { type: 'assistant', message: { content: [] } };
  return [init, assistant, result].map((message) => `${JSON.stringify(message)}\n`).join('');
}

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
