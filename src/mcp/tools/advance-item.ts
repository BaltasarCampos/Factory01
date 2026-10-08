// `advance_item` (contracts/mcp-tools.md, FR-022, FR-029b): asks the dispatcher to move the item
// to its next `state:`, by writing an `advance_request` event. It never changes a label. Its
// refusals are a courtesy to the session: the dispatcher derives the pause from the inbox
// timeline and signed resume records, and the item's state, again before any move.
import { join } from 'node:path';
import { appendEvent } from '../../events/append.js';
import { eventInput } from '../../hooks/log.js';
import { itemStatus } from '../../dispatcher/dispatch.js';
import { STATION_OF } from '../../dispatcher/transitions.js';
import { Fields, gh, numberArg, repoArg, type GhOptions } from '../../github/gh.js';
import { timeline } from '../../github/timeline.js';
import { loadConfig } from '../../model/config.js';
import { STATES, STATIONS, type State } from '../../model/types.js';
import { ulid } from '../../notify/inbox.js';
import { check, isText, toolName, type FactoryTool } from './input.js';

/** States a session may ask to leave: along the line, before `done`. */
const FROM = STATES.slice(0, STATES.indexOf('done'));
const EVIDENCE_MAX = 500;

async function labels(repo: string, issue: number, options: GhOptions): Promise<string[]> {
  const args = ['issue', 'view', numberArg(issue), '--repo', repoArg(repo), '--json', 'labels'];
  const view = Fields.of(await gh(args, { ...options, json: true }), 'issue');
  return view.list('labels').map((l) => Fields.of(l, 'label').str('name'));
}

const refuse = (reason: 'line paused' | 'station paused' | 'state mismatch') => ({
  accepted: false,
  reason,
});

export const advanceItem: FactoryTool = {
  name: 'advance_item',
  description:
    'Ask the dispatcher to move your item to its next state. The dispatcher checks the gate and ' +
    'any owner: record, then applies or rejects the move; this tool never changes a label.',
  inputSchema: {
    type: 'object',
    properties: {
      item: { type: 'integer', minimum: 1, description: 'Your item’s issue number' },
      from_state: { type: 'string', enum: FROM, description: 'The state you are moving it from' },
      evidence: { type: 'string', maxLength: EVIDENCE_MAX, description: 'Path to the hand-off' },
    },
    required: ['item', 'from_state', 'evidence'],
    additionalProperties: false,
  },
  async call(args, s, ctx) {
    const { from_state: from, evidence } = args;
    check(args, ['item', 'from_state', 'evidence'], s, [
      ...((FROM as readonly unknown[]).includes(from)
        ? []
        : [`from_state: one of ${FROM.join(', ')}`]),
      ...(isText(evidence, EVIDENCE_MAX) ? [] : [`evidence: text up to ${String(EVIDENCE_MAX)}`]),
    ]);
    const fromState = from as State;
    const to = STATES[STATES.indexOf(fromState) + 1] as State;
    const { item } = s.session;

    const config = await loadConfig(join(ctx.cwd, '.factory', 'config'));
    const options = { env: ctx.env };
    const inbox = await labels(config.repo, config.inbox_issue, options);
    if (inbox.includes('pause:line')) return refuse('line paused');
    const status = itemStatus(
      await labels(config.repo, item, options),
      await timeline(config.repo, item, options),
    );
    if (status.state !== fromState || STATION_OF[fromState] !== s.session.station)
      return refuse('state mismatch');
    // As in the transition table: an item waits on reaching a paused station, not on leaving one.
    const station = STATION_OF[to];
    if (
      station !== undefined &&
      station !== STATION_OF[fromState] &&
      inbox.includes(`pause:${STATIONS[station]}`)
    )
      return refuse('station paused');

    const request_id = ulid(ctx.now().getTime());
    const summary = { request_id, from_state: fromState, to_state: to, evidence };
    const fields = {
      kind: 'advance_request',
      tool: toolName('advance_item'),
      input_summary: JSON.stringify(summary),
    } as const;
    await appendEvent(s.log, eventInput(s.session, fields), ctx.now);
    return { accepted: true, request_id };
  },
};
