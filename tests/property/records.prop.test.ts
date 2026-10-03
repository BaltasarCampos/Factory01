import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse, serialise } from '../../src/approvals/record.js';
import { sign } from '../../src/approvals/sign.js';
import { STATIONS, type ApprovalRecord, type Tier } from '../../src/model/types.js';
import { makeKeys, sshVerifies, writeKeyFiles } from '../helpers/keys.js';

const hex = (length: number) => fc.stringMatching(new RegExp(`^[0-9a-f]{${String(length)}}$`));
const slug = fc
  .array(fc.stringMatching(/^[a-z0-9]{1,6}$/), { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join('-'));
const name = fc.stringMatching(/^[A-Za-z0-9-]{1,12}$/);
const issue = fc.integer({ min: 1, max: 99_999 });
const tier = fc.constantFrom<Tier>(1, 2, 3);
const timestamp = fc
  .date({
    min: new Date('2020-01-01T00:00:00Z'),
    max: new Date('2099-12-31T23:59:59Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z'));

const common = fc.record({
  repo: fc.tuple(name, name).map(([owner, repo]) => `${owner}/${repo}`),
  timestamp,
  nonce: hex(32),
});

/** Any valid record: every gate, every waiver-target form. */
const record: fc.Arbitrary<ApprovalRecord> = fc.oneof(
  fc
    .record({ c: common, issue, tier, slug, gate: fc.constantFrom('approved' as const) })
    .map(({ c, issue, tier, slug, gate }) => ({
      ...c,
      issue,
      gate,
      tier,
      branch: `claude/${String(issue)}-${slug}`,
    })),
  fc
    .record({ c: common, issue, tier, slug, spec: hex(40) })
    .map(({ c, issue, tier, slug, spec }) => ({
      ...c,
      issue,
      gate: 'spec-approved' as const,
      tier,
      branch: `claude/${String(issue)}-${slug}`,
      spec_sha: spec,
    })),
  fc
    .record({
      c: common,
      issue,
      tier,
      slug,
      gate: fc.constantFrom('red-green', 'coverage', 'size', 'ac-042', 'ci-build-test', 'plan'),
      head: hex(40),
    })
    .map(({ c, issue, tier, slug, gate, head }) => ({
      ...c,
      issue,
      gate: 'waiver' as const,
      tier,
      branch: `claude/${String(issue)}-${slug}`,
      waives: `gate:${gate}`,
      ...(gate === 'plan' ? {} : { head }),
    })),
  fc
    .record({
      c: common,
      issue,
      waives: fc.oneof(
        hex(40).map((sha) => `check:guardrail-change@v1.2.0@${sha}`),
        slug.map((pkg) => `dep:${pkg}@1.0.0`),
        slug.map((rule) => `finding:${rule}@src/${rule}.ts:7`),
      ),
    })
    .map(({ c, issue, waives }) => ({ ...c, issue, gate: 'waiver' as const, waives })),
  fc
    .record({ c: common, issue, scope: fc.constantFrom('line' as const, ...STATIONS) })
    .map(({ c, issue, scope }) => ({ ...c, issue, gate: 'resume' as const, scope })),
  fc
    .record({ c: common, issue, head: hex(40) })
    .map(({ c, issue, head }) => ({ ...c, issue, gate: 'deployed' as const, head })),
);

describe('approval records (properties)', () => {
  it('serialise → parse is the identity, and parse → serialise gives back the bytes (AC-070)', () => {
    fc.assert(
      fc.property(record, (r) => {
        const text = serialise(r);
        expect(parse(text)).toEqual(r);
        expect(serialise(parse(text))).toBe(text);
      }),
      { numRuns: 500 },
    );
  });

  it('any single-byte change to a signed record fails verification (AC-070, AC-079)', () => {
    const owner = makeKeys();
    const { allowedSigners } = writeKeyFiles([owner]);
    /** Verification as far as this slice goes: canonical parse + ssh-keygen -Y verify. */
    const verifies = (bytes: Buffer, signature: string): boolean => {
      try {
        parse(bytes.toString('utf8'));
      } catch {
        return false;
      }
      return sshVerifies(bytes, signature, allowedSigners);
    };

    fc.assert(
      fc.property(record, fc.nat(), fc.integer({ min: 1, max: 255 }), (r, at, delta) => {
        const { text, signature } = sign(r, owner.privateKey, { stdinIsTTY: true });
        const bytes = Buffer.from(text, 'utf8');
        expect(verifies(bytes, signature)).toBe(true);
        const i = at % bytes.length;
        bytes.writeUInt8((bytes.readUInt8(i) + delta) % 256, i);
        expect(verifies(bytes, signature)).toBe(false);
      }),
      { numRuns: 40 },
    );
  }, 60_000);
});
