// `request_split` (contracts/mcp-tools.md, FR-024, AC-037, AC-057): a task too big for its
// session or for the size limit goes back to Plan. The `split` event is the mark the dispatcher
// routes by (src/stations/edges.ts `splitFailure`); Plan files the work as new items, and the
// session stops.
import { appendEvent } from '../../events/append.js';
import { eventInput } from '../../hooks/log.js';
import { check, isText, toolName, type FactoryTool } from './input.js';

const REASONS = ['context limit', 'size limit'] as const;
const TASK = /^T\d{3,4}$/;
const NOTES_MAX = 2000;

export const requestSplit: FactoryTool = {
  name: 'request_split',
  description:
    'Hand your task back to Plan when it nears the context limit or will exceed the size limit. ' +
    'Plan splits it into new work items; stop the session once this returns.',
  inputSchema: {
    type: 'object',
    properties: {
      item: { type: 'integer', minimum: 1 },
      task: { type: 'string', pattern: TASK.source, description: 'Task ID, e.g. T007' },
      reason: { type: 'string', enum: REASONS },
      notes: { type: 'string', maxLength: NOTES_MAX },
    },
    required: ['item', 'task', 'reason'],
    additionalProperties: false,
  },
  async call(args, s, ctx) {
    const { task, reason, notes } = args;
    check(args, ['item', 'task', 'reason', 'notes'], s, [
      ...(typeof task === 'string' && TASK.test(task) ? [] : ['task: a task ID such as T007']),
      ...((REASONS as readonly unknown[]).includes(reason)
        ? []
        : [`reason: one of ${REASONS.join(', ')}`]),
      ...(notes === undefined || isText(notes, NOTES_MAX)
        ? []
        : [`notes: text up to ${String(NOTES_MAX)}`]),
    ]);
    const fields = {
      kind: 'split',
      tool: toolName('request_split'),
      input_summary: JSON.stringify({ task, reason, notes }),
    } as const;
    await appendEvent(s.log, eventInput(s.session, fields), ctx.now);
    const id = task as string;
    return {
      split: true,
      task: id,
      next: `${id} is returned to Plan, which splits it into new work items; stop this session now.`,
    };
  },
};
