import { chmodSync, copyFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  checkSecondCopy,
  keyOf,
  newestKey,
  secondCopy,
  pinOnMain,
  releaseKeys,
  type ReleaseKeys,
} from '../../src/approvals/keys.js';
import { firstUses, NonceLedger } from '../../src/approvals/nonces.js';
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
import {
  specBlobSha,
  verifyGate,
  verifySignature,
  type Expected,
  type GateCheck,
  type LabelAdd,
  type PostedComment,
} from '../../src/approvals/verify.js';
import type { ApprovalRecord } from '../../src/model/types.js';
import { makeRepo } from '../helpers/git-repo.js';
import {
  makeKeys,
  makeOtherKeys,
  sshVerifies,
  startAgent,
  tempDir,
  writeKeyFiles,
  type TestKeys,
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

describe('record verification (T033, contracts/approval-record.md steps 3–6)', () => {
  let old: TestKeys, owner: TestKeys, other: TestKeys;
  let keys: ReleaseKeys;
  beforeAll(() => {
    old = makeKeys();
    owner = makeKeys();
    other = makeOtherKeys();
    keys = writeKeyFiles([old, owner]);
  });

  let ids = 0;
  const at = (minute: number) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00Z`;
  const post = (record: ApprovalRecord, key: TestKeys, minute: number): PostedComment => ({
    id: String(++ids),
    createdAt: at(minute),
    body: renderComment(record, sign(record, key.privateKey, { stdinIsTTY: true })),
  });
  const added = (label: string, minute: number): LabelAdd => ({ label, createdAt: at(minute) });
  const approvedLabel = [added('owner:approved', 1)];
  const EXPECT: Expected = { repo: 'baltisark/sample', issue: 42, gate: 'approved', tier: 1 };

  const gate = (
    comments: PostedComment[],
    labelAdds: LabelAdd[] = approvedLabel,
    more: Partial<GateCheck> = {},
  ) =>
    verifyGate({
      keys,
      secondCopy: owner.publicKey,
      expected: EXPECT,
      comments,
      labelAdds,
      ...more,
    });

  describe('keys and signatures (AC-072, AC-084, AC-085)', () => {
    it('verifies a record signed with any listed key, including an older one (AC-084)', () => {
      expect(gate([post(VALID.approved, owner, 0)])).toMatchObject({ ok: true });
      expect(gate([post(VALID.approved, old, 0)])).toMatchObject({
        ok: true,
        record: VALID.approved,
      });
    });

    it('fails a record signed with a revoked or unknown key (AC-085)', () => {
      const revoked = writeKeyFiles([old, owner], [old]);
      expect(gate([post(VALID.approved, old, 0)], approvedLabel, { keys: revoked })).toMatchObject({
        ok: false,
        kind: 'tampering',
      });
      expect(gate([post(VALID.approved, owner, 0)], approvedLabel, { keys: revoked }).ok).toBe(
        true,
      );
      expect(gate([post(VALID.approved, other, 0)])).toMatchObject({
        ok: false,
        kind: 'tampering',
      });
    });

    it('decides by the ssh-keygen exit code only', () => {
      const signed = sign(VALID.approved, owner.privateKey, { stdinIsTTY: true });
      expect(verifySignature(signed, keys)).toBe(true);
      const fake = (stdout: string, code: number) => {
        const bin = tempDir('factory-fake-bin-');
        const script = join(bin, 'ssh-keygen');
        // Reads the record like the real tool; exiting unread can fail the write with EPIPE.
        writeFileSync(
          script,
          `#!/bin/sh\ncat >/dev/null\necho '${stdout}'\nexit ${String(code)}\n`,
        );
        chmodSync(script, 0o755);
        return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
      };
      expect(verifySignature(signed, keys, fake('Good "factory-approve" signature', 1))).toBe(
        false,
      );
      expect(verifySignature(signed, keys, fake('Could not verify signature.', 0))).toBe(true);
    });

    it('fails every record when the second copy is not the newest key (AC-072)', () => {
      const record = [post(VALID.approved, owner, 0)];
      for (const secondCopy of [other.publicKey, old.publicKey, undefined]) {
        expect(gate(record, approvedLabel, { secondCopy })).toMatchObject({
          ok: false,
          kind: 'tampering',
          reason: expect.stringMatching(/second copy/) as unknown,
        });
      }
    });

    it('compares the second copy after whitespace normalisation, ignoring comments', () => {
      const [type, blob] = owner.publicKey.split(' ');
      for (const secondCopy of [`  ${type}   ${blob} laptop\n`, owner.allowedSignersLine]) {
        expect(checkSecondCopy(keys, secondCopy)).toEqual({ status: 'ok' });
      }
    });

    it('takes the newest key as the last line not revoked', () => {
      expect(newestKey(keys)).toBe(owner.publicKey.split(' ').slice(0, 2).join(' '));
      const ownerRevoked = writeKeyFiles([old, owner], [owner]);
      expect(newestKey(ownerRevoked)).toBe(old.publicKey.split(' ').slice(0, 2).join(' '));
      expect(checkSecondCopy(ownerRevoked, old.publicKey)).toEqual({ status: 'ok' });
      const broken = writeKeyFiles([owner]);
      writeFileSync(broken.allowedSigners, 'owner not-a-key\n');
      expect(() => newestKey(broken)).toThrow(/not a public key line/);
    });

    it('takes the second copy from the routine variable in the cloud, the laptop key otherwise', () => {
      const home = tempDir();
      const cloud = { CLAUDE_CODE_REMOTE: '1', FACTORY_ALLOWED_SIGNERS: owner.publicKey };
      expect(secondCopy(cloud, home)).toBe(owner.publicKey);
      expect(secondCopy({ CLAUDE_CODE_REMOTE: '1' }, home)).toBeUndefined();
      expect(secondCopy({ FACTORY_ALLOWED_SIGNERS: other.publicKey }, home)).toBeUndefined();
      mkdirSync(join(home, '.factory', 'keys'), { recursive: true });
      copyFileSync(owner.publicKeyPath, join(home, '.factory', 'keys', 'approve_ed25519.pub'));
      expect(keyOf(secondCopy({ FACTORY_ALLOWED_SIGNERS: other.publicKey }, home) ?? '')).toBe(
        keyOf(owner.publicKey),
      );
    });

    it('reports rotation-pending, not tampering, while the second copy holds the previous key (AC-084)', () => {
      expect(checkSecondCopy(keys, old.publicKey, old.publicKey)).toMatchObject({
        status: 'rotation-pending',
      });
      expect(
        gate([post(VALID.approved, old, 0)], approvedLabel, {
          secondCopy: old.publicKey,
          previousNewest: old.publicKey,
        }),
      ).toMatchObject({ ok: false, kind: 'rotation-pending' });
      // A compromised previous key is never a pending rotation.
      const oldRevoked = writeKeyFiles([old, owner], [old]);
      expect(checkSecondCopy(oldRevoked, old.publicKey, old.publicKey)).toMatchObject({
        status: 'tampering',
      });
    });

    it("reads keys from the release pinned on main, never a pull request's copy (AC-084)", () => {
      const factory = makeRepo({
        files: { allowed_signers: `${owner.allowedSignersLine}\n`, revoked_keys: '' },
      });
      const good = factory.revParse('HEAD');
      const bad = factory.commit({ allowed_signers: `${other.allowedSignersLine}\n` }, 'swap');
      const config = (sha: string) =>
        `factory_release: v1.0.0@${sha}\nrepo: baltisark/sample\ninbox_issue: 1\n`;
      const project = makeRepo({ files: { '.factory/config': config(good) } });
      project.checkout('claude/42-add-login', { create: true });
      project.commit(
        { '.factory/config': config(bad), allowed_signers: `${other.allowedSignersLine}\n` },
        'pin the attacker release',
      );
      project.push();

      const pin = pinOnMain(project.path);
      expect(pin).toEqual({ tag: 'v1.0.0', sha: good });
      const pinned = releaseKeys(factory.path, pin.sha, tempDir());
      expect(gate([post(VALID.approved, owner, 0)], approvedLabel, { keys: pinned }).ok).toBe(true);
      expect(gate([post(VALID.approved, other, 0)], approvedLabel, { keys: pinned })).toMatchObject(
        { ok: false, kind: 'tampering' },
      );

      const noRevoked = factory.commit({ revoked_keys: null }, 'drop revoked_keys');
      expect(() => releaseKeys(factory.path, noRevoked, tempDir())).toThrow(/revoked_keys/);
    });
  });

  describe('labels and fields (AC-068, AC-070, AC-071)', () => {
    it('treats an owner: label without a matching record as tampering (AC-068)', () => {
      expect(gate([])).toMatchObject({
        ok: false,
        kind: 'tampering',
        reason: expect.stringMatching(/owner:approved.*without a matching record/) as unknown,
      });
      // A record backs only label-adds after its comment, and a forged one backs nothing.
      expect(gate([post(VALID.approved, owner, 2)])).toMatchObject({ kind: 'tampering' });
      expect(gate([post(VALID.approved, other, 0)])).toMatchObject({ kind: 'tampering' });
    });

    it('reports a record with no label as missing, not tampering', () => {
      expect(gate([post(VALID.approved, owner, 0)], [])).toMatchObject({ kind: 'missing' });
    });

    it('fails a record copied to another item or edited (AC-070)', () => {
      const comment = post(VALID.approved, owner, 0);
      expect(gate([comment], approvedLabel, { expected: { ...EXPECT, issue: 43 } })).toMatchObject({
        kind: 'tampering',
      });
      expect(
        gate([comment], approvedLabel, { expected: { ...EXPECT, repo: 'baltisark/other' } }),
      ).toMatchObject({ kind: 'tampering' });
      expect(gate([comment], approvedLabel, { expected: { ...EXPECT, tier: 3 } })).toMatchObject({
        kind: 'tampering',
      });
      const edited = { ...comment, body: comment.body.replace('tier: 1', 'tier: 3') };
      expect(gate([edited], approvedLabel, { expected: { ...EXPECT, tier: 3 } })).toMatchObject({
        kind: 'tampering',
      });
    });

    it('binds a spec approval to the current spec.md blob (AC-071)', () => {
      const repo = makeRepo({ files: { 'README.md': 'sample\n' } });
      repo.checkout('claude/42-add-login', { create: true });
      repo.commit({ 'specs/42-add-login/spec.md': '# Spec v1\n' }, 'spec');
      const blob = () => specBlobSha(repo.path, 'claude/42-add-login', 'specs/42-add-login/');
      const signedSha = blob();
      const comments = [post({ ...SPEC_APPROVED, spec_sha: signedSha }, owner, 0)];
      const check = (specSha: string) =>
        gate(comments, [added('owner:spec-approved', 1)], {
          expected: { ...EXPECT, gate: 'spec-approved', tier: 2, specSha },
        });
      expect(check(signedSha).ok).toBe(true);
      repo.commit({ 'specs/42-add-login/spec.md': '# Spec v2\n' }, 'edit spec');
      expect(blob()).not.toBe(signedSha);
      expect(check(blob())).toMatchObject({ ok: false, kind: 'stale' });
    });
  });

  describe('waivers (AC-089)', () => {
    const waiverLabel = [added('owner:waiver', 1)];
    const forItem: Expected = { ...EXPECT, gate: 'waiver', tier: 2 };

    it('counts a code-gate waiver only while the PR head equals its head', () => {
      const comments = [post(VALID['code-gate waiver'], owner, 0)];
      const check = (head: string) =>
        gate(comments, waiverLabel, { expected: { ...forItem, waives: 'gate:red-green', head } });
      expect(check(HEAD).ok).toBe(true);
      expect(check(RELEASE_SHA)).toMatchObject({ ok: false, kind: 'stale' });
    });

    it('keeps a pre-build gate waiver valid across new commits', () => {
      const comments = [post(VALID['pre-build gate waiver'], owner, 0)];
      const expected = { ...forItem, waives: 'gate:spec-approved', head: RELEASE_SHA };
      expect(gate(comments, waiverLabel, { expected }).ok).toBe(true);
    });

    it('binds each waiver target to its own issue', () => {
      const dep = [post(VALID['dependency waiver'], owner, 0)];
      const expectDep: Expected = {
        ...base,
        issue: 58,
        gate: 'waiver',
        waives: 'dep:@scope/pkg@1.2.3',
      };
      expect(gate(dep, waiverLabel, { expected: expectDep }).ok).toBe(true);
      expect(gate(dep, waiverLabel, { expected: { ...expectDep, issue: 59 } })).toMatchObject({
        ok: false,
      });
      expect(
        gate(dep, waiverLabel, { expected: { ...expectDep, waives: 'dep:other@1.0.0' } }),
      ).toMatchObject({ ok: false, kind: 'missing' });

      const upgrade = [post(VALID['upgrade waiver'], owner, 0)];
      const expectUpgrade: Expected = {
        ...base,
        issue: 57,
        gate: 'waiver',
        waives: `check:guardrail-change@v1.2.0@${RELEASE_SHA}`,
        branch: 'factory/upgrade-v1.2.0',
      };
      expect(gate(upgrade, waiverLabel, { expected: expectUpgrade }).ok).toBe(true);
      expect(
        gate(upgrade, waiverLabel, {
          expected: { ...expectUpgrade, branch: 'factory/upgrade-v1.3.0' },
        }),
      ).toMatchObject({ ok: false, kind: 'tampering' });
    });
  });

  describe('single use (AC-079)', () => {
    it('rejects a nonce backing a second label-add', () => {
      const original = post(VALID.approved, owner, 0);
      const reAdded = [...approvedLabel, added('owner:approved', 5)];
      expect(gate([original], reAdded)).toMatchObject({ ok: false, kind: 'tampering' });
      const copy = { ...original, id: 'copy', createdAt: at(4) };
      expect(gate([original, copy], reAdded)).toMatchObject({ ok: false, kind: 'replay' });
    });

    it('rejects a nonce the laptop ledger saw on another comment', () => {
      const ledger = new NonceLedger(join(tempDir(), 'nonces.log'));
      const comment = post(VALID.approved, owner, 0);
      expect(gate([comment], approvedLabel, { ledger }).ok).toBe(true);
      expect(gate([comment], approvedLabel, { ledger }).ok).toBe(true);
      const elsewhere = { ...comment, id: 'reposted' };
      expect(gate([elsewhere], approvedLabel, { ledger })).toMatchObject({
        ok: false,
        kind: 'replay',
        reason: expect.stringMatching(/nonces\.log/) as unknown,
      });
    });

    it('keeps only the first use of each nonce for resume and deployed records', () => {
      const resume = { record: VALID['line resume'] };
      const later = { record: { ...VALID['station resume'], nonce: newNonce() } };
      const { first, replays } = firstUses([resume, later, { record: VALID['line resume'] }]);
      expect(first).toEqual([resume, later]);
      expect(replays).toHaveLength(1);
    });
  });
});
