import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig, RELEASE_LIMITS } from '../../src/model/config.js';
import { tempDir } from '../helpers/keys.js';

const SHA40 = '3f9a0c1d2e3f4a5b6c7d8e9f0011223344556677';

const base: Record<string, string> = {
  factory_release: `v1.0.0@${SHA40}`,
  agents: 'cloud',
  profile: 'typescript',
  repo: 'owner/sample',
  inbox_issue: '1',
};

function yaml(fields: Record<string, string | undefined>): string {
  return Object.entries(fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${k}: ${v}\n`)
    .join('');
}

function problems(text: string): string[] {
  try {
    parseConfig(text);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error('expected ConfigError');
}

describe('.factory/config loading (AC-002)', () => {
  it('loads a complete config and fills defaults', () => {
    const config = parseConfig(yaml(base));
    expect(config).toEqual({
      factory_release: { tag: 'v1.0.0', sha: SHA40 },
      agents: 'cloud',
      profile: 'typescript',
      repo: 'owner/sample',
      inbox_issue: 1,
      parallel_sessions: 1,
      retry_limit: 3,
      size_limit_lines: RELEASE_LIMITS.sizeLimitLines,
      coverage_min: RELEASE_LIMITS.coverageMin,
    });
  });

  describe('factory_release: "Required" as <tag>@<sha>', () => {
    it('is required', () => {
      expect(problems(yaml({ ...base, factory_release: undefined }))).toEqual([
        'factory_release: required',
      ]);
    });

    it('rejects a bare tag', () => {
      expect(problems(yaml({ ...base, factory_release: 'v1.0.0' }))[0]).toMatch(
        /^factory_release: must be <tag>@<40-hex sha>/,
      );
    });

    it.each([
      'v1.0@' + SHA40,
      'v1.0.0@' + SHA40.slice(1),
      'v1.0.0@' + SHA40.toUpperCase(),
      'latest@' + SHA40,
    ])('rejects %s', (pin) => {
      expect(problems(yaml({ ...base, factory_release: pin }))[0]).toMatch(/^factory_release:/);
    });
  });

  describe('baseline: optional 40-hex commit', () => {
    it('is absent unless given', () => {
      expect(parseConfig(yaml(base)).baseline).toBeUndefined();
    });

    it('accepts a 40-hex commit, even one YAML would read as a number', () => {
      const digits = '1234567890123456789012345678901234567890';
      expect(parseConfig(yaml({ ...base, baseline: digits })).baseline).toBe(digits);
    });

    it('rejects anything else', () => {
      expect(problems(yaml({ ...base, baseline: 'abc' }))).toEqual([
        'baseline: must be a 40-hex commit',
      ]);
    });
  });

  describe('agents: "cloud" | "local", "Required before any cloud session"', () => {
    it.each(['cloud', 'local'])('accepts %s', (agents) => {
      expect(parseConfig(yaml({ ...base, agents })).agents).toBe(agents);
    });

    it('may be absent when loading; the cloud launcher refuses later (AC-002)', () => {
      expect(parseConfig(yaml({ ...base, agents: undefined })).agents).toBeUndefined();
    });

    it.each(['no', 'yes', 'Cloud', 'remote'])('rejects %s', (agents) => {
      expect(problems(yaml({ ...base, agents }))).toEqual(['agents: must be cloud or local']);
    });
  });

  describe('profile: "typescript" only', () => {
    it('defaults to typescript', () => {
      expect(parseConfig(yaml({ ...base, profile: undefined })).profile).toBe('typescript');
    });

    it('rejects any other profile', () => {
      expect(problems(yaml({ ...base, profile: 'python' }))).toEqual([
        'profile: only typescript is approved',
      ]);
    });
  });

  describe('repo: "owner/name"', () => {
    it('is required', () => {
      expect(problems(yaml({ ...base, repo: undefined }))).toEqual(['repo: required']);
    });

    it.each(['sample', 'owner/', '/sample', 'a/b/c', 'owner/sam ple'])('rejects %s', (repo) => {
      expect(problems(yaml({ ...base, repo: `"${repo}"` }))).toEqual(['repo: must be owner/name']);
    });
  });

  describe('inbox_issue: number', () => {
    it('is required', () => {
      expect(problems(yaml({ ...base, inbox_issue: undefined }))).toEqual([
        'inbox_issue: required',
      ]);
    });

    it.each(['0', '-1', '1.5', 'one'])('rejects %s', (n) => {
      expect(problems(yaml({ ...base, inbox_issue: n }))).toEqual([
        'inbox_issue: must be a positive integer',
      ]);
    });
  });

  describe('parallel_sessions: "number, default 1" (changed only through factory config set)', () => {
    it('defaults to 1', () => {
      expect(parseConfig(yaml(base)).parallel_sessions).toBe(1);
    });

    it('accepts a higher value set on main by an Owner-signed commit', () => {
      expect(parseConfig(yaml({ ...base, parallel_sessions: '2' })).parallel_sessions).toBe(2);
    });

    it('rejects zero', () => {
      expect(problems(yaml({ ...base, parallel_sessions: '0' }))).toEqual([
        'parallel_sessions: must be a positive integer',
      ]);
    });
  });

  describe('retry_limit: "default 3"', () => {
    it('defaults to 3', () => {
      expect(parseConfig(yaml(base)).retry_limit).toBe(3);
    });

    it('accepts another positive integer', () => {
      expect(parseConfig(yaml({ ...base, retry_limit: '5' })).retry_limit).toBe(5);
    });
  });

  describe('size_limit_lines: "default = the release\'s limit (400)", may only be lowered', () => {
    it('defaults to the release limit', () => {
      expect(RELEASE_LIMITS.sizeLimitLines).toBe(400);
      expect(parseConfig(yaml(base)).size_limit_lines).toBe(400);
    });

    it('may be lowered', () => {
      expect(parseConfig(yaml({ ...base, size_limit_lines: '250' })).size_limit_lines).toBe(250);
    });

    it('rejects a value above the release limit', () => {
      expect(problems(yaml({ ...base, size_limit_lines: '401' }))).toEqual([
        "size_limit_lines: may only be lowered below the release's limit (400)",
      ]);
    });

    it('uses the release limit it is given', () => {
      expect(() =>
        parseConfig(yaml({ ...base, size_limit_lines: '300' }), {
          sizeLimitLines: 200,
          coverageMin: 90,
        }),
      ).toThrow(ConfigError);
    });
  });

  describe('coverage_min: "default = the release\'s floor (90)", may only be raised', () => {
    it('defaults to the release floor', () => {
      expect(RELEASE_LIMITS.coverageMin).toBe(90);
      expect(parseConfig(yaml(base)).coverage_min).toBe(90);
    });

    it('may be raised up to 100', () => {
      expect(parseConfig(yaml({ ...base, coverage_min: '95' })).coverage_min).toBe(95);
    });

    it('rejects a weaker value', () => {
      expect(problems(yaml({ ...base, coverage_min: '89' }))).toEqual([
        "coverage_min: may only be raised above the release's floor (90)",
      ]);
    });

    it('rejects a value above 100', () => {
      expect(problems(yaml({ ...base, coverage_min: '101' }))).toEqual([
        'coverage_min: must be at most 100',
      ]);
    });
  });

  describe('file shape', () => {
    it('rejects unknown keys', () => {
      expect(problems(yaml({ ...base, auto_merge: 'true' }))).toEqual(['auto_merge: unknown key']);
    });

    it('rejects duplicate keys', () => {
      expect(problems(yaml(base) + 'agents: local\n')[0]).toMatch(/duplicate|unique/i);
    });

    it('rejects nested values', () => {
      expect(problems(yaml(base) + 'retry_limit:\n  - 3\n')).toEqual([
        'retry_limit: must be a single value',
      ]);
    });

    it.each([
      ['an empty file', ''],
      ['a list', '- a\n- b\n'],
      ['a scalar', 'cloud\n'],
    ])('rejects %s', (_label, text) => {
      expect(problems(text)).toEqual(['config must be a YAML mapping']);
    });

    it('reports every problem at once', () => {
      expect(problems(yaml({ ...base, repo: undefined, agents: 'maybe' }))).toEqual([
        'agents: must be cloud or local',
        'repo: required',
      ]);
    });
  });

  describe('loadConfig', () => {
    it('reads and checks .factory/config from disk', async () => {
      const path = join(tempDir(), 'config');
      writeFileSync(path, yaml(base));
      await expect(loadConfig(path)).resolves.toMatchObject({ repo: 'owner/sample' });
    });

    it('rejects an invalid file from disk', async () => {
      const path = join(tempDir(), 'config');
      writeFileSync(path, yaml({ ...base, coverage_min: '50' }));
      await expect(loadConfig(path)).rejects.toThrow(ConfigError);
    });
  });
});
