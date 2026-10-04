// The Owner inbox (FR-034a, data-model.md § Owner inbox entry): every alert is a comment on the
// pinned inbox issue headed by
//
//   <!-- factory-alert id=<ulid> urgency=urgent|info kind=<kind> -->
//
// Urgent alerts also fail the owner-alert workflow so GitHub emails the Owner, because comments
// and @mentions alone notify no one (agents act as the Owner's account). Which alerts the Owner
// has read is laptop state: ids in ~/.factory/inbox-read.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { listComments, postComment, type IssueComment } from '../github/comments.js';
import type { GhOptions } from '../github/gh.js';
import { loadConfig } from '../model/config.js';
import type { Alert } from '../model/types.js';
import { triggerOwnerAlert } from './owner-alert.js';

export interface InboxTarget extends GhOptions {
  repo: string;
  inboxIssue: number;
}

export interface NewAlert {
  urgency: Alert['urgency'];
  /** Lower-case words joined by hyphens, e.g. `tampering`, `guardrail-mismatch`. */
  kind: string;
  text: string;
  /** Links to the evidence (runs, commits, comments). */
  evidence?: readonly string[];
}

const KIND_RE = /^[a-z]+(-[a-z]+)*$/;
const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MARKER_RE =
  /^<!-- factory-alert id=([0-9A-HJKMNP-TV-Z]{26}) urgency=(urgent|info) kind=([a-z]+(?:-[a-z]+)*) -->(?:\n|$)/;

/** A ULID: 48-bit millisecond time then 80 random bits, Crockford base32, so ids sort by time. */
export function ulid(now: number = Date.now(), random: Buffer = randomBytes(10)): string {
  let time = '';
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) {
    time = ULID_CHARS.charAt(t % 32) + time;
  }
  let bits = BigInt(`0x${random.toString('hex')}`);
  let rest = '';
  for (let i = 0; i < 16; i++, bits >>= 5n) rest = ULID_CHARS.charAt(Number(bits & 31n)) + rest;
  return time + rest;
}

/** Post an alert to the inbox (and, if urgent, fail owner-alert.yml); returns its id. */
export async function alert(
  target: InboxTarget,
  input: NewAlert,
  deps: { now?: () => number } = {},
): Promise<string> {
  if (!KIND_RE.test(input.kind))
    throw new Error(`invalid alert kind ${JSON.stringify(input.kind)}`);
  const id = ulid(deps.now?.());
  const marker = `<!-- factory-alert id=${id} urgency=${input.urgency} kind=${input.kind} -->`;
  const evidence = (input.evidence ?? []).map((link) => `- ${link}`);
  const body = [marker, '', input.text, ...(evidence.length > 0 ? ['', ...evidence] : [])];
  await postComment(target.repo, target.inboxIssue, `${body.join('\n')}\n`, target);
  if (input.urgency === 'urgent') await triggerOwnerAlert(target.repo, id, target);
  return id;
}

/**
 * The alert in a comment, or undefined when the comment does not start with a well-formed
 * marker. The text is its first non-empty line with control characters removed, so a comment
 * cannot drive the Owner's terminal.
 */
export function parseAlert(comment: IssueComment): Alert | undefined {
  const match = MARKER_RE.exec(comment.body);
  if (!match) return undefined;
  const [marker, id = '', urgency, kind = ''] = match;
  const line =
    comment.body
      .slice(marker.length)
      .split('\n')
      .find((l) => l.trim() !== '') ?? '';
  const text = line.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return { id, urgency: urgency === 'urgent' ? 'urgent' : 'info', kind, text };
}

/** Every alert on the inbox issue, oldest first. */
export async function listAlerts(target: InboxTarget): Promise<Alert[]> {
  const comments = await listComments(target.repo, target.inboxIssue, target);
  return comments.map(parseAlert).filter((a): a is Alert => a !== undefined);
}

export function inboxReadPath(home: string): string {
  return join(home, '.factory', 'inbox-read');
}

export function readIds(home: string): Set<string> {
  const file = inboxReadPath(home);
  if (!existsSync(file)) return new Set();
  return new Set(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l !== ''),
  );
}

export function markRead(home: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const file = inboxReadPath(home);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, ids.map((id) => `${id}\n`).join(''));
}

export async function unreadAlerts(target: InboxTarget & { home: string }): Promise<Alert[]> {
  const read = readIds(target.home);
  return (await listAlerts(target)).filter((a) => !read.has(a.id));
}

/** The inbox named by `<dir>/.factory/config`, or undefined outside a factory project. */
export async function projectInbox(
  dir: string,
  env: NodeJS.ProcessEnv,
): Promise<(InboxTarget & { home: string }) | undefined> {
  const file = join(dir, '.factory', 'config');
  if (!existsSync(file)) return undefined;
  const config = await loadConfig(file);
  return { repo: config.repo, inboxIssue: config.inbox_issue, home: env.HOME ?? homedir(), env };
}

/** The CLI preamble's reader: unread alerts of the project in `dir`, none outside a project. */
export async function projectUnreadAlerts(dir: string, env: NodeJS.ProcessEnv): Promise<Alert[]> {
  const inbox = await projectInbox(dir, env);
  return inbox === undefined ? [] : unreadAlerts(inbox);
}

export function alertLines(alerts: readonly Alert[]): string {
  return alerts
    .map((a) => {
      const level = a.urgency === 'urgent' ? 'URGENT' : 'info  ';
      return `  ${level}  ${a.kind}: ${a.text}${a.url === undefined ? '' : `  ${a.url}`}\n`;
    })
    .join('');
}
