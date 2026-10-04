// Appending events (R12, FR-028): one JSON line per event, added with fs.appendFile only, so
// earlier bytes are never rewritten. The writer fills `ts`; a caller's value is ignored.
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Event } from '../model/types.js';
import { redact } from './redact.js';
import { validateEvent } from './schema.js';

export type EventInput = Omit<Event, 'ts'>;

/** Pre-merge: the item's feature folder. Post-merge: the `claude/factory-log` working copy. */
export type LogTarget = { featureDir: string } | { factoryLog: string };

export function eventLogPath(target: LogTarget, ts: string): string {
  if ('featureDir' in target) return join(target.featureDir, 'events.jsonl');
  const month = new Date(ts).toISOString().slice(0, 7);
  return join(target.factoryLog, '.factory', 'events', `${month}.jsonl`);
}

export async function appendEvent(
  target: string | LogTarget,
  input: EventInput,
  now: () => Date = () => new Date(),
): Promise<Event> {
  const fields: EventInput & { ts?: unknown } = { ...input };
  delete fields.ts;
  const event = validateEvent({
    ts: now().toISOString(),
    ...fields,
    ...(fields.tool === undefined ? {} : { tool: redact(fields.tool) }),
    ...(fields.input_summary === undefined ? {} : { input_summary: redact(fields.input_summary) }),
    ...(fields.evidence === undefined ? {} : { evidence: redact(fields.evidence) }),
  });
  const path = typeof target === 'string' ? target : eventLogPath(target, event.ts);
  await mkdir(dirname(path), { recursive: true });
  // A last line cut short (no newline) stays as it is; the new line starts on its own.
  const text = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
  const lead = text.length > 0 && text[text.length - 1] !== 0x0a ? '\n' : '';
  await appendFile(path, `${lead}${JSON.stringify(event)}\n`);
  return event;
}
