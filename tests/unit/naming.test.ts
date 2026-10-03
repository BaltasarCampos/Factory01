import { describe, expect, it } from 'vitest';
import {
  featureDir,
  formatReleasePin,
  isSlug,
  itemBranch,
  parseReleasePin,
  slugify,
} from '../../src/model/naming.js';
import { ROLES, STATES, STATIONS } from '../../src/model/types.js';

describe('work item naming (data-model.md § Work item)', () => {
  describe('slug: "derived from title, kebab-case, ≤ 40 chars"', () => {
    it.each([
      ['Add login page', 'add-login-page'],
      ['  Fix: crash on   empty  input!! ', 'fix-crash-on-empty-input'],
      ['Café señal über', 'cafe-senal-uber'],
      ['Use node:sqlite for storage', 'use-node-sqlite-for-storage'],
      ['---', 'item'],
      ['日本語', 'item'],
    ])('%j → %s', (title, slug) => {
      expect(slugify(title)).toBe(slug);
    });

    it('cuts to 40 characters without a trailing hyphen', () => {
      const slug = slugify('a'.repeat(39) + ' bcdef');
      expect(slug).toBe('a'.repeat(39));
      expect(slugify('word '.repeat(20)).length).toBeLessThanOrEqual(40);
      expect(isSlug(slugify('word '.repeat(20)))).toBe(true);
    });

    it.each(['add-login', 'a', 'v2-api'])('accepts %s', (slug) => {
      expect(isSlug(slug)).toBe(true);
    });

    it.each(['Add-login', '-a', 'a-', 'a--b', 'a_b', '', 'a'.repeat(41)])('rejects %j', (slug) => {
      expect(isSlug(slug)).toBe(false);
    });
  });

  it('branch is claude/<issue>-<slug>', () => {
    expect(itemBranch(42, 'add-login')).toBe('claude/42-add-login');
  });

  it('feature_dir is specs/<issue>-<slug>/', () => {
    expect(featureDir(42, 'add-login')).toBe('specs/42-add-login/');
  });

  it.each([
    [0, 'ok'],
    [-1, 'ok'],
    [1.5, 'ok'],
    [7, 'Bad Slug'],
    [7, '../escape'],
  ])('refuses issue %s with slug %j', (issue, slug) => {
    expect(() => itemBranch(issue, slug)).toThrow();
    expect(() => featureDir(issue, slug)).toThrow();
  });
});

describe('release pin <tag>@<sha>', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';

  it('round-trips', () => {
    const pin = parseReleasePin(`v1.2.3@${sha}`);
    expect(pin).toEqual({ tag: 'v1.2.3', sha });
    expect(pin && formatReleasePin(pin)).toBe(`v1.2.3@${sha}`);
  });

  it.each(['v1.2.3', `v1.2@${sha}`, `1.2.3@${sha}`, `v1.2.3@${sha}0`, `v1.2.3@ ${sha}`])(
    'rejects %s',
    (text) => {
      expect(parseReleasePin(text)).toBeUndefined();
    },
  );
});

describe('fixed sets (data-model.md)', () => {
  it('has stations 0–8 in order', () => {
    expect(STATIONS).toEqual([
      'define',
      'intake',
      'specify',
      'plan',
      'build',
      'verify',
      'integrate',
      'release',
      'operate',
    ]);
  });

  it('has the 10 line states plus blocked and escalated', () => {
    expect(STATES).toHaveLength(12);
    expect(STATES.slice(0, 10)).toEqual([
      'new',
      'triaged',
      'specified',
      'spec-approved',
      'planned',
      'building',
      'verifying',
      'integrating',
      'releasing',
      'done',
    ]);
    expect(STATES).toContain('blocked');
    expect(STATES).toContain('escalated');
  });

  it('has exactly twelve roles', () => {
    expect(new Set(ROLES).size).toBe(12);
  });
});
