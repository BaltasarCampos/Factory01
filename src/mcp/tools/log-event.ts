// `log_event` (contracts/mcp-tools.md, AC-048): appends one Event. `ts`, `role`, `session`,
// `model`, the station and the role version come from the session; the caller's values for them
// are ignored. A session logs only what it originates: tool calls, gate results and usage.
// Approvals, alerts, Owner comments and caps come from the Owner and the dispatcher, and splits
// and advance requests have their own tools.
import { appendEvent, type EventInput } from '../../events/append.js';
import { EventError } from '../../events/schema.js';
import { eventInput } from '../../hooks/log.js';
import { check, InvalidInput, isText, type FactoryTool } from './input.js';

const KINDS = ['tool_call', 'gate_result', 'usage'] as const;
const FIELDS = ['tool', 'input_summary', 'gate', 'pass', 'evidence', 'usage'] as const;
/** Filled from the session, whatever the caller sends. */
const SESSION_FIELDS = ['ts', 'role', 'session', 'model', 'station', 'role_version'];
const TEXT_MAX = 2000;

export const logEvent: FactoryTool = {
  name: 'log_event',
  description:
    'Log one structured event (a tool call, gate result or usage) to your item’s event log. ' +
    'Time, role, session and model are filled in for you.',
  inputSchema: {
    type: 'object',
    properties: {
      item: { type: 'integer', minimum: 0 },
      kind: { type: 'string', enum: KINDS },
      tool: { type: 'string', maxLength: TEXT_MAX },
      input_summary: { type: 'string', maxLength: TEXT_MAX },
      gate: { type: 'string', maxLength: TEXT_MAX, description: 'gate_result only' },
      pass: { type: 'boolean', description: 'gate_result only' },
      evidence: { type: 'string', maxLength: TEXT_MAX, description: 'gate_result only' },
      usage: {
        type: 'object',
        properties: { sessions: { type: 'integer' }, est_share: { type: 'number' } },
        description: 'usage only',
      },
    },
    required: ['item', 'kind'],
  },
  async call(args, s, ctx) {
    const kind = KINDS.find((k) => k === args.kind);
    const long = ['tool', 'input_summary', 'gate', 'evidence'].filter(
      (key) => args[key] !== undefined && !isText(args[key], TEXT_MAX),
    );
    check(args, ['item', 'kind', ...FIELDS, ...SESSION_FIELDS], s, [
      ...(kind === undefined ? [`kind: one of ${KINDS.join(', ')}`] : []),
      ...long.map((key) => `${key}: text up to ${String(TEXT_MAX)}`),
    ]);
    const fields = Object.fromEntries(
      FIELDS.flatMap((key) => (key in args ? [[key, args[key]]] : [])),
    );
    try {
      await appendEvent(s.log, eventInput(s.session, { ...fields, kind } as EventInput), ctx.now);
    } catch (err) {
      if (err instanceof EventError) throw new InvalidInput(err.problems);
      throw err;
    }
    return { logged: true };
  },
};
