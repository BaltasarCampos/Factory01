// `factory approve <issue|pr> [spec | waiver <waives>]` (contracts/cli.md, FR-016d, FR-016e):
// sign a record on the laptop, post it on the issue, then apply its `owner:` label. The record
// comment is also the approval event: the dispatcher copies the issue's records into the item's
// `events.jsonl` when it creates the branch (T059). Nothing is posted or labelled unless signing
// succeeds.
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { secondCopy, type ReleaseKeys } from '../approvals/keys.js';
import { NonceLedger, nonceLedgerPath } from '../approvals/nonces.js';
import {
  isCodeGateWaiver,
  newNonce,
  RecordError,
  recordTimestamp,
  renderComment,
  serialise,
} from '../approvals/record.js';
import { ownerKeyPath, sign } from '../approvals/sign.js';
import { specBlobSha, verifyGate } from '../approvals/verify.js';
import type { CommandContext } from '../cli/commands.js';
import { ExitCode, RefusedError, UsageError } from '../cli/env.js';
import { listComments, postComment } from '../github/comments.js';
import { Fields, gh, numberArg, repoArg } from '../github/gh.js';
import { addLabel, removeLabel } from '../github/labels.js';
import { viewPr } from '../github/prs.js';
import { timeline } from '../github/timeline.js';
import { itemBranch, slugify } from '../model/naming.js';
import type { ApprovalGate, ApprovalRecord, Tier } from '../model/types.js';
import { projectHere } from './pause.js';

type Project = Awaited<ReturnType<typeof projectHere>>;
type RecordFields = Pick<ApprovalRecord, 'tier' | 'branch' | 'spec_sha' | 'waives' | 'head'>;

/**
 * The laptop's own key list (`~/.factory/allowed_signers`, written by `factory keygen`) and
 * revocation list; an absent revocation list is created empty.
 */
export function laptopKeys(home: string): ReleaseKeys {
  const dir = join(home, '.factory');
  const keys = {
    allowedSigners: join(dir, 'allowed_signers'),
    revokedKeys: join(dir, 'revoked_keys'),
  };
  if (!existsSync(keys.allowedSigners))
    throw new RefusedError(`${keys.allowedSigners} not found; run factory keygen first`);
  if (!existsSync(keys.revokedKeys)) writeFileSync(keys.revokedKeys, '');
  return keys;
}

/** Sign a record, post it on its issue and claim its nonce in the laptop ledger. */
export async function postSigned(
  ctx: CommandContext,
  project: Project,
  record: ApprovalRecord,
): Promise<void> {
  const signed = sign(record, ownerKeyPath(project.home), {
    stdinIsTTY: ctx.stdinIsTTY,
    env: ctx.env,
  });
  const body = renderComment(record, signed);
  await postComment(project.repo, record.issue, body, project);
  const comments = await listComments(project.repo, record.issue, project);
  const posted = comments.findLast((c) => c.body.trim() === body.trim());
  if (posted === undefined)
    throw new RefusedError(`the record posted on #${String(record.issue)} could not be read back`);
  const ref = `${project.repo}#${String(record.issue)}/${posted.id}`;
  new NonceLedger(nonceLedgerPath(project.home)).claim(record.nonce, ref);
}

async function viewIssue(project: Project, issue: number) {
  const args = ['issue', 'view', numberArg(issue), '--repo', repoArg(project.repo)];
  const f = Fields.of(
    await gh([...args, '--json', 'title,labels'], { ...project, json: true }),
    'issue',
  );
  return {
    title: f.str('title'),
    labels: f.list('labels').map((l) => Fields.of(l, 'label').str('name')),
  };
}

function confirmedTier(option: unknown, labels: readonly string[], issue: number): Tier {
  if (option !== undefined) {
    if (typeof option !== 'string' || !/^[123]$/.test(option))
      throw new UsageError('--tier must be 1, 2 or 3');
    return Number(option) as Tier;
  }
  const proposed = labels.filter((l) => /^tier:[123]$/.test(l));
  const [only] = proposed;
  if (only === undefined || proposed.length > 1)
    throw new RefusedError(
      `#${String(issue)} has ${proposed.length === 0 ? 'no' : 'several'} proposed tier: labels; ` +
        'confirm the tier with --tier <1|2|3>',
    );
  return Number(only.slice('tier:'.length)) as Tier;
}

/** Tier and branch from the item's verified `approved` record, which fixes both. */
async function approvedRecord(
  project: Project,
  issue: number,
): Promise<{ tier: Tier; branch: string }> {
  const comments = await listComments(project.repo, issue, project);
  const labelAdds = (await timeline(project.repo, issue, project)).filter(
    (e) => e.event === 'labeled',
  );
  const verdict = verifyGate({
    keys: laptopKeys(project.home),
    secondCopy: secondCopy(project.env ?? {}, project.home),
    expected: { repo: project.repo, issue, gate: 'approved' },
    comments,
    labelAdds,
    ledger: new NonceLedger(nonceLedgerPath(project.home)),
  });
  if (!verdict.ok)
    throw new RefusedError(
      `#${String(issue)} has no verified owner:approved (${verdict.reason}); approve the item first`,
    );
  const { tier, branch } = verdict.record;
  // The record format requires both for an approved record.
  if (tier === undefined || branch === undefined) throw new RefusedError('malformed approval');
  return { tier, branch };
}

function specSha(project: Project, branch: string): string {
  const fetched = spawnSync('git', ['-C', project.cwd, 'fetch', '-q', 'origin', branch], {
    env: project.env,
    encoding: 'utf8',
  });
  if (fetched.status !== 0)
    throw new RefusedError(`cannot fetch ${branch}: ${fetched.stderr.trim()}`);
  try {
    return specBlobSha(project.cwd, `origin/${branch}`, `specs/${branch.slice('claude/'.length)}`);
  } catch (err) {
    throw new RefusedError(err instanceof Error ? err.message : String(err));
  }
}

async function fieldsFor(
  ctx: CommandContext,
  project: Project,
  issue: number,
  gate: ApprovalGate,
  waives: string | undefined,
): Promise<{ fields: RecordFields; labels: string[] }> {
  const { title, labels } = await viewIssue(project, issue);
  if (gate === 'approved') {
    const tier = confirmedTier(ctx.options.tier, labels, issue);
    return { fields: { tier, branch: itemBranch(issue, slugify(title)) }, labels };
  }
  if (gate === 'spec-approved') {
    const { tier, branch } = await approvedRecord(project, issue);
    return { fields: { tier, branch, spec_sha: specSha(project, branch) }, labels };
  }
  const target = waives ?? '';
  if (target.startsWith('check:') || target.startsWith('dep:'))
    throw new RefusedError(
      `waivers on pull requests (${target.split(':')[0] ?? ''}:) are not supported in this build yet`,
    );
  if (!target.startsWith('gate:')) return { fields: { waives: target }, labels };
  const { tier, branch } = await approvedRecord(project, issue);
  const head = isCodeGateWaiver(target)
    ? { head: (await viewPr(project.repo, branch, project)).headRefOid }
    : {};
  return { fields: { tier, branch, waives: target, ...head }, labels };
}

const GATE_OF: Record<string, ApprovalGate | undefined> = {
  spec: 'spec-approved',
  waiver: 'waiver',
};

export async function approve(ctx: CommandContext): Promise<number> {
  const [target = '', kind, waives] = ctx.positionals;
  if (!/^[1-9]\d*$/.test(target)) throw new UsageError(`not an issue or PR number: ${target}`);
  const issue = Number(target);
  const gate = kind === undefined ? 'approved' : GATE_OF[kind];
  if (gate === undefined) throw new UsageError(`expected spec or waiver, got ${kind ?? ''}`);
  if (gate === 'waiver' && waives === undefined)
    throw new UsageError('waiver needs a target, e.g. gate:coverage');
  if (gate !== 'waiver' && waives !== undefined)
    throw new UsageError(`unexpected argument: ${waives}`);
  if (gate !== 'approved' && ctx.options.tier !== undefined)
    throw new UsageError('--tier is confirmed only when approving the item itself');

  const project = await projectHere(ctx);
  const { fields, labels } = await fieldsFor(ctx, project, issue, gate, waives);
  const record: ApprovalRecord = {
    repo: project.repo,
    issue,
    gate,
    ...fields,
    timestamp: recordTimestamp(ctx.now()),
    nonce: newNonce(),
  };
  let text: string;
  try {
    text = serialise(record);
  } catch (err) {
    if (err instanceof RecordError) throw new UsageError(err.message);
    throw err;
  }
  ctx.io.stdout.write(`Signing for ${project.repo}#${String(issue)}:\n\n${text}\n`);

  await postSigned(ctx, project, record);
  // A fresh label-add after the record, so the new record is the one backing the label.
  const label = `owner:${gate}`;
  if (labels.includes(label)) await removeLabel(project.repo, issue, label, project);
  await addLabel(project.repo, issue, label, project);
  ctx.io.stdout.write(`Applied ${label} to #${String(issue)}.\n`);
  return ExitCode.Ok;
}
