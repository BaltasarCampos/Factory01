// The laptop's record of the factory's alerts (T030): an alert is raised once by that record,
// which only a post that succeeded writes, never by what the inbox holds.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { alertFile } from '../../src/notify/alert-record.js';
import { alert, alertOnce, type NewAlert } from '../../src/notify/inbox.js';
import { readState, seedState } from '../helpers/fake-gh.js';
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
});
