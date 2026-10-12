// Which waiver the merge summary names for an early-warning line (T068, slice 22a-4): 21b's exact
// rule, the line's own target or `test:<its own file>`, never a prefix match on `#`.
import { describe, expect, it } from 'vitest';
import { coveringWaiver } from '../../src/merge/view.js';
import { weakenedTests } from '../../src/stations/edges.js';

const lineIn = (path: string) => {
  const diff = [
    {
      path,
      status: 'modified' as const,
      added: ["it.skip('adds', () => {});"],
      removed: ["it('adds', () => {});"],
    },
  ];
  const [line] = weakenedTests(diff, {
    waivers: new Set(),
    openIssues: new Set(),
    helpers: new Set(),
  }).findings;
  if (line === undefined) throw new Error('no early-warning line');
  return line;
};

describe('the waiver named for an early-warning line (T068)', () => {
  it('carries its file apart from its target, so a # in the path is never split on', () => {
    expect(lineIn('tests/a#b.test.ts')).toMatchObject({
      file: 'tests/a#b.test.ts',
      target: 'test:tests/a#b.test.ts#adds',
    });
  });

  it('a waiver test:tests/a is never named for a line in tests/a#b.test.ts', () => {
    expect(coveringWaiver(['test:tests/a'], lineIn('tests/a#b.test.ts'))).toBeUndefined();
  });

  it('names the waiver equal to the line target, or to test:<its own file>', () => {
    const line = lineIn('tests/a#b.test.ts');
    expect(coveringWaiver(['test:tests/a#b.test.ts#adds'], line)).toBe(
      'test:tests/a#b.test.ts#adds',
    );
    expect(coveringWaiver(['test:tests/a', 'test:tests/a#b.test.ts'], line)).toBe(
      'test:tests/a#b.test.ts',
    );
  });
});
