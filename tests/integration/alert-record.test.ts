// The laptop's record of the factory's alerts (T030): an alert is raised once by that record,
// which only a post that succeeded writes, never by what the inbox holds.
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { alertFile } from '../../src/notify/alert-record.js';
import { alert, alertOnce, retryEmails, type NewAlert } from '../../src/notify/inbox.js';
import { failWorkflows, readState, seedState } from '../helpers/fake-gh.js';
import { tempDir } from '../helpers/keys.js';

const REPO = 'owner/project';
const NOTE: NewAlert = { urgency: 'info', kind: 'note', text: '#2 holds: no role file' };
/** The inbox comment of an alert like `NOTE`, as anyone on a public repository could post it. */
const FORGED = `<!-- factory-alert id=01J0000000000000000000000A urgency=info kind=note -->\n\n${NOTE.text}\n`;

function setup(comments: string[] = []) {
  seedState({
    repos: {
      [REPO]: {
        issues: [
          {
            number: 1,
            title: 'Owner inbox',
            comments: comments.map((body, i) => ({
              ...{ id: i + 1, author: 'stranger', body, createdAt: '2026-10-01T08:00:00Z' },
            })),
          },
        ],
      },
    },
  });
  const target = { repo: REPO, inboxIssue: 1, home: tempDir() };
  return { target, file: alertFile(target.home, REPO, NOTE) };
}

const posted = () => (readState().repos[REPO]?.issues[0]?.comments ?? []).map((c) => c.body);
const emailed = () => readState().repos[REPO]?.workflowRuns ?? [];

describe('alertOnce: one alert per kind, text and urgency, by the laptop’s record (T030)', () => {
  it('posts once and records the posted id, however often it is raised', async () => {
    const { target, file } = setup();

    await alertOnce(target, NOTE);
    await alertOnce(target, NOTE);

    expect(posted()).toHaveLength(1);
    const record = JSON.parse(readFileSync(file, 'utf8')) as { id: string };
    expect(record).toEqual({ ...NOTE, id: record.id });
    expect(posted()[0]).toContain(`id=${record.id} `);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('posts its alert although the inbox already holds a comment that reads the same', async () => {
    const { target } = setup([FORGED]);

    await alertOnce(target, NOTE);

    expect(posted()).toHaveLength(2);
  });

  it('keys by kind, text and urgency: a change in any one of them is another alert', async () => {
    const { target } = setup();
    const others: NewAlert[] = [
      { ...NOTE, urgency: 'urgent' },
      { ...NOTE, kind: 'other' },
      { ...NOTE, text: '#3 holds: no role file' },
    ];

    for (const input of [NOTE, ...others, NOTE, ...others]) await alertOnce(target, input);

    expect(posted()).toHaveLength(4);
  });

  it('names the file by a hash, so no alert text becomes a path', async () => {
    const { target } = setup();
    const input = { ...NOTE, text: '../../../../etc/passwd\n/x' };

    await alertOnce(target, input);

    const folder = join(target.home, '.factory', 'alerts', 'owner', 'project');
    const hash = createHash('sha256')
      .update(JSON.stringify([input.kind, input.urgency, input.text]))
      .digest('hex');
    expect(readdirSync(folder)).toEqual([`${hash}.json`]);
  });

  it('records nothing for a post that fails, so the next time posts it', async () => {
    const { target, file } = setup();

    await expect(alertOnce({ ...target, inboxIssue: 99 }, NOTE)).rejects.toThrow(
      /gh issue comment 99 /,
    );
    expect(() => statSync(file)).toThrow(/ENOENT/);
    await alertOnce(target, NOTE);

    expect(posted()).toHaveLength(1);
  });

  const record = { ...NOTE, id: '01J0000000000000000000000A' };
  it.each([
    ['a folder', undefined, 'cannot be read'],
    ['not JSON', '{', 'cannot be read'],
    ['null', 'null', 'is malformed'],
    ['with a field of its own', JSON.stringify({ ...record, sent: true }), 'is malformed'],
    ['with no id', JSON.stringify(NOTE), 'is malformed'],
    ['of another alert', JSON.stringify({ ...record, text: 'x' }), 'is malformed'],
    ['pending an info alert', JSON.stringify({ ...record, email: 'pending' }), 'is malformed'],
    ['with another email state', JSON.stringify({ ...record, email: 'sent' }), 'is malformed'],
  ])(
    'stops, naming the file and the way out, on a record that is %s, never reading it as raised or not',
    async (_name, text, said) => {
      const { target, file } = setup();
      mkdirSync(text === undefined ? file : dirname(file), { recursive: true });
      if (text !== undefined) writeFileSync(file, text);

      const raised = alertOnce(target, NOTE);

      await expect(raised).rejects.toThrow(`the alert record ${file} ${said}`);
      await expect(raised).rejects.toThrow(
        /delete it, by its path, and its alert is posted again$/,
      );
      expect(posted()).toEqual([]);
    },
  );

  it('fails when the posted alert cannot be recorded, naming the file', async () => {
    const { target, file } = setup();
    // A file where the record's folder goes: nothing under it can be written.
    writeFileSync(join(target.home, '.factory'), '');

    await expect(alert(target, NOTE)).rejects.toThrow(
      new RegExp(`the alert record .*${basename(file)} cannot be written: .*posted again`),
    );

    expect(posted()).toHaveLength(1);
  });

  it('still sends an urgent alert’s email when it cannot be recorded, then fails', async () => {
    const { target } = setup();
    writeFileSync(join(target.home, '.factory'), '');

    await expect(alert(target, { ...NOTE, urgency: 'urgent' })).rejects.toThrow(/posted again/);

    expect(emailed()).toHaveLength(1);
  });

  it('names both failures when the record cannot be written and the email trigger fails', async () => {
    const { target } = setup();
    writeFileSync(join(target.home, '.factory'), '');
    failWorkflows(REPO, 'no workflow owner-alert.yml');

    await expect(alert(target, { ...NOTE, urgency: 'urgent' })).rejects.toThrow(
      /the alert record .*cannot be written: [^]*; and its email trigger failed: .*no workflow owner-alert\.yml/,
    );
  });
});

describe('an urgent alert’s email, recorded apart and retried (T030)', () => {
  const URGENT: NewAlert = { urgency: 'urgent', kind: 'tampering', text: 'a forged label on #2' };
  const OTHER: NewAlert = { ...URGENT, text: 'a forged label on #3' };
  const DOWN = 'no workflow owner-alert.yml';

  /** A target whose email trigger fails, with where its records are. */
  function failing() {
    const { target } = setup();
    failWorkflows(REPO, DOWN);
    const file = alertFile(target.home, REPO, URGENT);
    return { target, file, spell: join(dirname(file), 'email-failing') };
  }
  const pending = (file: string) =>
    (JSON.parse(readFileSync(file, 'utf8')) as { email?: string }).email;
  const spells = () => posted().filter((body) => body.includes('kind=email-failing'));
  const sent = () => emailed().map((run) => run.inputs.alert_id);

  it('records a failed trigger as pending, never throws it, and says why in one info alert', async () => {
    const { target, file, spell } = failing();

    const id = await alert(target, URGENT);

    expect(pending(file)).toBe('pending');
    expect(posted()).toHaveLength(2);
    expect(posted()[1]).toMatch(
      /urgency=info kind=email-failing -->\n\nurgent alerts' emails are not going out: check that owner-alert\.yml is on the default branch[^]*no workflow owner-alert\.yml/,
    );
    expect(posted()[0]).toContain(`id=${id} `);
    expect(statSync(spell).isFile()).toBe(true);
    expect(emailed()).toEqual([]);
  });

  it('alerts a failing spell once, however its error changes, with each email pending', async () => {
    const { target, file } = failing();
    await alert(target, URGENT);
    failWorkflows(REPO, 'HTTP 502');

    await alertOnce(target, OTHER);
    await retryEmails(target);

    expect(spells()).toHaveLength(1);
    expect(pending(file)).toBe('pending');
    expect(pending(alertFile(target.home, REPO, OTHER))).toBe('pending');
  });

  it('retries only the trigger, once for each pending email, until it succeeds', async () => {
    const { target, file, spell } = failing();
    const first = await alert(target, URGENT);
    const second = await alert(target, OTHER);
    const comments = posted();

    await alertOnce(target, URGENT);
    failWorkflows(REPO, undefined);
    await retryEmails(target);
    await retryEmails(target);

    expect(posted()).toEqual(comments);
    expect(sent()).toEqual([first, second]);
    expect(pending(file)).toBeUndefined();
    expect(() => statSync(spell)).toThrow(/ENOENT/);
  });

  it('alerts the next spell again once a trigger has succeeded', async () => {
    const { target } = failing();
    await alert(target, URGENT);
    failWorkflows(REPO, undefined);
    await retryEmails(target);
    failWorkflows(REPO, DOWN);

    await alert(target, OTHER);

    expect(spells()).toHaveLength(2);
  });

  it('records nothing pending for an email that went out, nor for an info alert', async () => {
    const { target, file } = setup();

    await alert(target, NOTE);
    await alert(target, URGENT);
    await retryEmails(target);

    expect(readFileSync(file, 'utf8')).not.toContain('email');
    expect(pending(alertFile(target.home, REPO, URGENT))).toBeUndefined();
    expect(emailed()).toHaveLength(1);
  });

  it('retries nothing for a record with no email state, nor reads other files as records', async () => {
    const { target } = setup();
    const file = alertFile(target.home, REPO, URGENT);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...URGENT, id: '01J0000000000000000000000A' }));
    writeFileSync(`${file}.cut-short.tmp`, '{');

    await retryEmails(target);

    expect(emailed()).toEqual([]);
  });

  it('stops on a failed post of the spell’s alert, leaving the email pending', async () => {
    const { target, file, spell } = failing();
    await alert(target, URGENT);
    rmSync(spell);

    await expect(retryEmails({ ...target, inboxIssue: 99 })).rejects.toThrow(
      /gh issue comment 99 /,
    );

    expect(pending(file)).toBe('pending');
  });

  it.each([
    [
      'a record is malformed',
      (file: string) => {
        writeFileSync(file, '{}');
      },
      /is malformed/,
    ],
    [
      'the spell’s file cannot be read',
      (file: string) => {
        const spell = join(dirname(file), 'email-failing');
        rmSync(spell);
        symlinkSync(spell, spell);
      },
      /email-failing cannot be read: [^]*delete it/,
    ],
    [
      'the spell’s file cannot be removed',
      (file: string) => {
        const spell = join(dirname(file), 'email-failing');
        rmSync(spell);
        mkdirSync(spell);
        failWorkflows(REPO, undefined);
      },
      /email-failing cannot be removed: [^]*delete it/,
    ],
    [
      'the records cannot be listed',
      (file: string) => {
        rmSync(dirname(file), { recursive: true });
        writeFileSync(dirname(file), '');
      },
      /cannot be listed: [^]*a folder you can read/,
    ],
  ])('stops, naming the way out, when %s', async (_name, spoil, said) => {
    const { target, file } = failing();
    await alert(target, URGENT);
    spoil(file);

    await expect(retryEmails(target)).rejects.toThrow(said);
  });
});
