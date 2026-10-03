import { renameSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  extractFromComment,
  FIELD_ORDER,
  isCodeGateWaiver,
  newNonce,
  parse,
  recordTimestamp,
  RecordError,
  renderComment,
  serialise,
} from '../../src/approvals/record.js';
import { sign, SigningError } from '../../src/approvals/sign.js';
import type { ApprovalRecord } from '../../src/model/types.js';
import {
  makeKeys,
  makeOtherKeys,
  sshVerifies,
  startAgent,
  writeKeyFiles,
} from '../helpers/keys.js';

const SPEC_SHA = '3b18e512dba79e4c8300dd08aeb37f8e728b8dad';
const HEAD = '1c9d0e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3';
const RELEASE_SHA = 'aa11bb22cc33dd44ee55ff6600778899aabbccdd';
const NONCE = '9f2c1e0a7b4d4e8f8a1b2c3d4e5f6a7b';
const TS = '2026-10-01T09:12:44Z';
const base = { repo: 'baltisark/sample', timestamp: TS, nonce: NONCE };

const SPEC_APPROVED: ApprovalRecord = {
  ...base,
  issue: 42,
  gate: 'spec-approved',
  tier: 2,
  branch: 'claude/42-add-login',
  spec_sha: SPEC_SHA,
};

/** The contract example, byte for byte. */
const SPEC_APPROVED_TEXT = `factory-approve/v1
repo: baltisark/sample
issue: 42
gate: spec-approved
tier: 2
branch: claude/42-add-login
spec_sha: ${SPEC_SHA}
timestamp: ${TS}
nonce: ${NONCE}
`;

const VALID = {
  approved: { ...base, issue: 42, gate: 'approved', tier: 1, branch: 'claude/42-add-login' },
  'spec-approved': SPEC_APPROVED,
  'code-gate waiver': {
    ...base,
    issue: 42,
    gate: 'waiver',
    tier: 2,
    branch: 'claude/42-add-login',
    waives: 'gate:red-green',
    head: HEAD,
  },
  'pre-build gate waiver': {
    ...base,
    issue: 42,
    gate: 'waiver',
    tier: 2,
    branch: 'claude/42-add-login',
    waives: 'gate:spec-approved',
  },
  'upgrade waiver': {
    ...base,
    issue: 57,
    gate: 'waiver',
    branch: 'factory/upgrade-v1.2.0',
    waives: `check:guardrail-change@v1.2.0@${RELEASE_SHA}`,
  },
  'dependency waiver': { ...base, issue: 58, gate: 'waiver', waives: 'dep:@scope/pkg@1.2.3' },
  'finding waiver': {
    ...base,
    issue: 59,
    gate: 'waiver',
    tier: 3,
    branch: 'claude/59-fix-xss',
    waives: 'finding:js-xss@src/view.ts:12',
  },
  'line resume': { ...base, issue: 1, gate: 'resume', scope: 'line' },
  'station resume': { ...base, issue: 1, gate: 'resume', scope: 'build' },
  deployed: { ...base, issue: 1, gate: 'deployed', head: HEAD },
} satisfies Record<string, ApprovalRecord>;

type OptionalField = 'tier' | 'branch' | 'spec_sha' | 'scope' | 'waives' | 'head';

function omit(record: ApprovalRecord, key: OptionalField): ApprovalRecord {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key)) as ApprovalRecord;
}

function rejection(text: string): string {
  try {
    parse(text);
  } catch (err) {
    if (err instanceof RecordError) return err.message;
    throw err;
  }
  throw new Error('expected RecordError');
}

/** Replace one line of the canonical example (or drop it with `null`). */
function edit(key: string, line: string | null, text = SPEC_APPROVED_TEXT): string {
  return text
    .split('\n')
    .flatMap((l) => (l.startsWith(`${key}: `) ? (line === null ? [] : [line]) : [l]))
    .join('\n');
}

describe('approval record canonical form (AC-070)', () => {
  it('serialises the contract example byte for byte', () => {
    expect(serialise(SPEC_APPROVED)).toBe(SPEC_APPROVED_TEXT);
    expect(parse(SPEC_APPROVED_TEXT)).toEqual(SPEC_APPROVED);
  });

  it('writes fields in the fixed order whatever the object key order', () => {
    const waiver: ApprovalRecord = VALID['code-gate waiver'];
    const reversed = Object.fromEntries(Object.entries(waiver).reverse()) as ApprovalRecord;
    const keys = serialise(reversed)
      .split('\n')
      .slice(1, -1)
      .map((l) => l.split(':')[0]);
    expect(keys).toEqual(FIELD_ORDER.filter((k) => k in waiver));
  });

  it.each(Object.entries(VALID))('round-trips a valid %s record', (_name, record) => {
    expect(parse(serialise(record))).toEqual(record);
  });

  it('omits absent fields instead of writing them empty', () => {
    expect(serialise(VALID.approved)).not.toMatch(/spec_sha|scope|waives|head/);
    expect(rejection(edit('spec_sha', 'spec_sha: '))).toMatch(
      /spec_sha: absent fields are omitted/,
    );
    expect(() => serialise({ ...VALID.approved, head: '' })).toThrow(/head: absent fields/);
  });

  it.each([
    ['CRLF line endings', SPEC_APPROVED_TEXT.replace(/\n/g, '\r\n')],
    ['a trailing space', edit('tier', 'tier: 2 ')],
    ['two spaces after the colon', edit('tier', 'tier:  2')],
    ['fields out of order', edit('tier', null).replace('nonce:', 'tier: 2\nnonce:')],
    ['a duplicated field', edit('tier', 'tier: 2\ntier: 2')],
    ['an unknown field', edit('tier', 'tier: 2\nmerged: yes')],
    ['a blank line', edit('tier', 'tier: 2\n')],
    ['no final newline', SPEC_APPROVED_TEXT.slice(0, -1)],
    ['another format version', SPEC_APPROVED_TEXT.replace('/v1', '/v2')],
    ['a leading zero in the issue', edit('issue', 'issue: 042')],
    ['an uppercase field name', edit('tier', 'Tier: 2')],
  ])('rejects %s', (_name, text) => {
    expect(() => parse(text)).toThrow(RecordError);
  });

  describe('gate', () => {
    it.each(['approved', 'spec-approved', 'waiver', 'resume', 'deployed'])('accepts %s', (gate) => {
      const record = Object.values(VALID).find((r) => r.gate === gate);
      expect(record && parse(serialise(record)).gate).toBe(gate);
    });

    it.each(['merged', 'Approved', 'approve', ''])('rejects gate %j', (gate) => {
      expect(rejection(edit('gate', `gate: ${gate}`))).toMatch(/gate:/);
    });
  });

  describe('fields required and forbidden per gate', () => {
    it.each([
      ['approved without branch', omit(VALID.approved, 'branch'), /branch: required/],
      ['approved without tier', omit(VALID.approved, 'tier'), /tier: required/],
      [
        'approved with spec_sha',
        { ...VALID.approved, spec_sha: SPEC_SHA },
        /spec_sha: not allowed/,
      ],
      ['spec-approved without spec_sha', omit(SPEC_APPROVED, 'spec_sha'), /spec_sha: required/],
      ['resume without scope', omit(VALID['line resume'], 'scope'), /scope: required/],
      ['resume with tier', { ...VALID['line resume'], tier: 1 }, /tier: not allowed/],
      ['deployed without head', omit(VALID.deployed, 'head'), /head: required/],
      ['waiver without waives', omit(VALID['upgrade waiver'], 'waives'), /waives: required/],
      ['approved with waives', { ...VALID.approved, waives: 'gate:size' }, /waives: not allowed/],
    ] satisfies [string, ApprovalRecord, RegExp][])('rejects %s', (_name, record, problem) => {
      expect(() => serialise(record)).toThrow(problem);
      expect(() => serialise(record)).toThrow(RecordError);
    });

    it('binds approved and spec-approved branches to their own issue', () => {
      expect(() => serialise({ ...VALID.approved, branch: 'claude/43-add-login' })).toThrow(
        /branch: must be claude\/42-<slug>/,
      );
      expect(() => serialise({ ...SPEC_APPROVED, branch: 'main' })).toThrow(/branch:/);
      expect(() => serialise({ ...SPEC_APPROVED, branch: 'claude/42-Add_Login' })).toThrow(
        /branch:/,
      );
    });

    it('accepts every resume scope: line or a station name', () => {
      for (const scope of ['line', 'define', 'operate'] as const) {
        expect(() => serialise({ ...VALID['line resume'], scope })).not.toThrow();
      }
      const resume = serialise(VALID['line resume']);
      expect(rejection(edit('scope', 'scope: deploy', resume))).toMatch(/^scope: /);
    });
  });

  describe('field values', () => {
    it.each([
      ['nonce of 31 hex chars', 'nonce', `nonce: ${NONCE.slice(1)}`],
      ['nonce of 33 hex chars', 'nonce', `nonce: ${NONCE}0`],
      ['uppercase nonce', 'nonce', `nonce: ${NONCE.toUpperCase()}`],
      ['non-hex nonce', 'nonce', `nonce: ${NONCE.slice(1)}g`],
      ['timestamp with an offset', 'timestamp', 'timestamp: 2026-10-01T10:12:44+01:00'],
      ['timestamp with fractions', 'timestamp', 'timestamp: 2026-10-01T09:12:44.123Z'],
      ['impossible date', 'timestamp', 'timestamp: 2026-02-30T09:12:44Z'],
      ['repo without owner', 'repo', 'repo: sample'],
      ['issue 0', 'issue', 'issue: 0'],
      ['tier 4', 'tier', 'tier: 4'],
      ['short spec_sha', 'spec_sha', `spec_sha: ${SPEC_SHA.slice(1)}`],
    ])('rejects a %s', (_name, key, line) => {
      expect(rejection(edit(key, line))).toMatch(new RegExp(`^${key}: `));
    });
  });

  describe('waiver targets (data-model.md § Waiver targets)', () => {
    const waiver = (waives: string, head?: string): ApprovalRecord => ({
      ...VALID['pre-build gate waiver'],
      waives,
      ...(head === undefined ? {} : { head }),
    });

    it.each(['red-green', 'coverage', 'size', 'ac-042', 'ci-build-test'])(
      'gate:%s is a code gate: head is required (AC-089)',
      (gate) => {
        expect(isCodeGateWaiver(`gate:${gate}`)).toBe(true);
        expect(() => serialise(waiver(`gate:${gate}`, HEAD))).not.toThrow();
        expect(() => serialise(waiver(`gate:${gate}`))).toThrow(/head: required/);
      },
    );

    it.each(['spec-approved', 'plan'])(
      'gate:%s is a pre-build gate and carries no head',
      (gate) => {
        expect(isCodeGateWaiver(`gate:${gate}`)).toBe(false);
        expect(() => serialise(waiver(`gate:${gate}`))).not.toThrow();
        expect(() => serialise(waiver(`gate:${gate}`, HEAD))).toThrow(/head: not allowed/);
      },
    );

    it('requires tier and an item branch for gate: waivers, which target a work item', () => {
      expect(() => serialise(omit(waiver('gate:plan'), 'tier'))).toThrow(/tier: required/);
      expect(() => serialise({ ...waiver('gate:plan'), branch: 'claude/define' })).toThrow(
        /branch: must be claude\/42-<slug>/,
      );
    });

    it.each([
      `check:guardrail-change@v1.2.0@${RELEASE_SHA}`,
      'dep:left-pad@1.3.0',
      'dep:@types/node@24.19.1',
      'finding:js-xss@src/view.ts:12',
    ])('accepts %s without head', (waives) => {
      const record: ApprovalRecord = { ...base, issue: 60, gate: 'waiver', waives };
      expect(parse(serialise(record))).toEqual(record);
      expect(() => serialise({ ...record, head: HEAD })).toThrow(/head: not allowed/);
    });

    it.each([
      'gate:',
      'gate:Red_Green',
      'check:guardrail-change@v1.2.0',
      `check:other@v1.2.0@${RELEASE_SHA}`,
      'dep:left-pad',
      'finding:js-xss@src/view.ts',
      'finding:js-xss@src/view.ts:0',
      'other:thing',
    ])('rejects the malformed target %s', (waives) => {
      expect(() => serialise({ ...base, issue: 60, gate: 'waiver', waives })).toThrow(/waives:/);
    });
  });

  it('makes 32-hex nonces that differ and second-precision UTC timestamps', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => newNonce()));
    expect(nonces.size).toBe(50);
    for (const n of nonces) expect(n).toMatch(/^[0-9a-f]{32}$/);
    expect(recordTimestamp(new Date('2026-10-01T09:12:44.987Z'))).toBe(TS);
  });
});

describe('record comment envelope (contracts/approval-record.md, step 1)', () => {
  const SIGNATURE =
    '-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\nAAAA==\n-----END SSH SIGNATURE-----\n';
  const signed = { text: SPEC_APPROVED_TEXT, signature: SIGNATURE };

  it('renders the posting format and extracts the same bytes back', () => {
    const body = renderComment(SPEC_APPROVED, signed);
    expect(body.startsWith('<!-- factory-record v1 -->\n')).toBe(true);
    expect(body).toContain('**Owner approval**: spec-approved for #42 (tier 2)');
    expect(body).toContain(`\`\`\`factory-record\n${SPEC_APPROVED_TEXT}\`\`\`\n`);
    expect(extractFromComment(body)).toEqual(signed);
  });

  it.each([
    ['no signature block', (b: string) => b.replace(/```factory-signature[\s\S]*?```\n/, '')],
    ['no record block', (b: string) => b.replace(/```factory-record[\s\S]*?```\n/, '')],
    [
      'two record blocks',
      (b: string) => `${b}\n\`\`\`factory-record\n${SPEC_APPROVED_TEXT}\`\`\`\n`,
    ],
    ['an unterminated block', (b: string) => b.replace(/```\n*$/, '')],
    [
      'a signature that is not an SSH signature',
      (b: string) => b.replace('U1NIU0lH', 'not base64!'),
    ],
    ['CRLF line endings', (b: string) => b.replace(/\n/g, '\r\n')],
  ])('rejects a comment with %s', (_name, mangle) => {
    expect(() => extractFromComment(mangle(renderComment(SPEC_APPROVED, signed)))).toThrow(
      RecordError,
    );
  });
});

describe('signing records with ssh-keygen (T032)', () => {
  it('signs the canonical bytes under namespace factory-approve only', () => {
    const owner = makeKeys();
    const { allowedSigners } = writeKeyFiles([owner]);
    const signed = sign(SPEC_APPROVED, owner.privateKey, { stdinIsTTY: true });
    expect(signed.text).toBe(SPEC_APPROVED_TEXT);
    expect(signed.signature).toMatch(
      /^-----BEGIN SSH SIGNATURE-----\n[\s\S]+-----END SSH SIGNATURE-----\n$/,
    );
    expect(sshVerifies(signed.text, signed.signature, allowedSigners)).toBe(true);
    expect(sshVerifies(signed.text, signed.signature, allowedSigners, 'git')).toBe(false);
    expect(
      sshVerifies(signed.text, signed.signature, writeKeyFiles([makeOtherKeys()]).allowedSigners),
    ).toBe(false);
    expect(extractFromComment(renderComment(SPEC_APPROVED, signed))).toEqual(signed);
  });

  it('refuses without a terminal for the passphrase', () => {
    const owner = makeKeys();
    expect(() => sign(SPEC_APPROVED, owner.privateKey, { stdinIsTTY: false })).toThrow(/terminal/);
  });

  it('refuses an invalid record before signing', () => {
    const owner = makeKeys();
    expect(() =>
      sign({ ...SPEC_APPROVED, nonce: 'x' }, owner.privateKey, { stdinIsTTY: true }),
    ).toThrow(RecordError);
  });

  it('never signs through an ssh-agent, even one holding the key', () => {
    const owner = makeKeys();
    const socket = startAgent(owner);
    renameSync(owner.privateKey, `${owner.privateKey}.moved`);
    const env = { ...process.env, SSH_AUTH_SOCK: socket };
    expect(() => sign(SPEC_APPROVED, owner.privateKey, { stdinIsTTY: true, env })).toThrow(
      SigningError,
    );
  });

  it('reports a missing key file', () => {
    expect(() => sign(SPEC_APPROVED, '/nonexistent/approve_ed25519', { stdinIsTTY: true })).toThrow(
      /\/nonexistent\/approve_ed25519/,
    );
  });
});
