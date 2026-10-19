// `factory ci licences <base> <head>` (T169, contracts/ci-checks.md, FR-049, Owner decisions
// 2026-10-18): every package whose name and version in the head's `package-lock.json` are not in
// the merge base's must have a licence the release's `licences.json` allows. The lockfile only
// names the packages, after the lockfile identity rule (lockfile.ts) has tied each entry to the
// registry tarball of its name and version: each licence is read from registry.npmjs.org for that
// exact version, since the Builder writes the lockfile and could edit its `license` fields. A
// failed lookup fails. The registry's legacy `licenses` array reads as an OR of its types.
//
// An SPDX expression passes when it evaluates to allowed: an `OR` needs one allowed side, an `AND`
// both, and `<licence> WITH <exception>` passes only when listed whole. Anything that does not
// parse (`SEE LICENSE IN …`) fails, and so do a missing licence and `UNLICENSED`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RefusedError } from '../cli/env.js';
import { fileAt, mergeBase } from '../git/diff.js';
import { REGISTRY } from './audit.js';
import { LOCK, readLockfile } from './lockfile.js';
import { RELEASE_CI } from './test.js';

const PARALLEL = 8;
const TIMEOUT_MS = 30_000;

/** Whether the SPDX expression is allowed; false when it does not parse. */
export function licenceAllowed(expression: string, allowed: ReadonlySet<string>): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const peek = () => tokens[at]?.toUpperCase();
  const fail = () => {
    throw new SyntaxError(expression);
  };
  function atom(): boolean {
    if (tokens[at] === '(') {
      at += 1;
      const inner = or();
      if (tokens[at] !== ')') fail();
      at += 1;
      return inner;
    }
    const id = tokens[at];
    if (id === undefined || id === ')' || ['AND', 'OR', 'WITH'].includes(peek() ?? '')) fail();
    at += 1;
    if (peek() !== 'WITH') return allowed.has(id ?? '');
    const exception = tokens[at + 1];
    if (exception === undefined || exception === '(' || exception === ')') fail();
    at += 2;
    return allowed.has(`${id ?? ''} WITH ${exception ?? ''}`);
  }
  function and(): boolean {
    let ok = atom();
    while (peek() === 'AND') {
      at += 1;
      ok = atom() && ok;
    }
    return ok;
  }
  function or(): boolean {
    let ok = and();
    while (peek() === 'OR') {
      at += 1;
      ok = and() || ok;
    }
    return ok;
  }
  try {
    const ok = or();
    return at === tokens.length && ok;
  } catch {
    return false;
  }
}

/** The licence the registry gives `name` at `version`, or a problem with the lookup. */
async function registryLicence(
  registry: string,
  pkg: string,
): Promise<{ licence?: string; problem?: string }> {
  const cut = pkg.lastIndexOf('@');
  const [name, version] = [pkg.slice(0, cut), pkg.slice(cut + 1)];
  const url = `${registry}/${name.replace('/', '%2f')}/${encodeURIComponent(version)}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return { problem: `the registry answered ${String(response.status)}` };
    const body = (await response.json()) as { license?: unknown; licenses?: unknown };
    const typeOf = (l: unknown) =>
      typeof l === 'string' ? l : (l as { type?: unknown } | null | undefined)?.type;
    const licence = typeOf(body.license);
    if (typeof licence === 'string') return { licence };
    // The legacy `licenses` array: any one of its types may be chosen, so an OR of them.
    const types = Array.isArray(body.licenses) ? body.licenses.map(typeOf) : [];
    if (types.length === 0 || !types.every((t): t is string => typeof t === 'string')) return {};
    return { licence: `(${types.join(' OR ')})` };
  } catch (err) {
    return { problem: `the registry lookup failed: ${(err as Error).message}` };
  }
}

export async function checkLicences(
  repo: string,
  base: string,
  head: string,
  env: NodeJS.ProcessEnv,
  registry = REGISTRY,
): Promise<{ findings: string[]; checked: number }> {
  const { allowed } = JSON.parse(readFileSync(join(RELEASE_CI, 'licences.json'), 'utf8')) as {
    allowed: string[];
  };
  const start = mergeBase(repo, base, head, env);
  if (fileAt(repo, head, LOCK, env) === undefined && fileAt(repo, start, LOCK, env) !== undefined)
    throw new RefusedError(`no ${LOCK} at the head ${head.slice(0, 12)}`);
  // The lockfile identity rule first (lockfile.ts): the lookups must name what npm installs.
  const atHead = readLockfile(repo, head, env);
  if (atHead.problems.length > 0) return { findings: atHead.problems, checked: 0 };
  const key = (p: { name: string; version: string }) => `${p.name}@${p.version}`;
  const before = new Set(readLockfile(repo, start, env).packages.map(key));
  const changed = [...new Set(atHead.packages.map(key))].filter((p) => !before.has(p)).sort();
  const list = new Set(allowed);
  const findings: string[] = [];
  for (let i = 0; i < changed.length; i += PARALLEL) {
    const batch = changed.slice(i, i + PARALLEL);
    const looked = await Promise.all(batch.map((pkg) => registryLicence(registry, pkg)));
    looked.forEach(({ licence, problem }, j) => {
      const pkg = batch[j] ?? '';
      if (problem !== undefined) findings.push(`${pkg}: ${problem}`);
      else if (licence === undefined) findings.push(`${pkg}: no licence on the registry`);
      else if (!licenceAllowed(licence, list))
        findings.push(`${pkg}: licence ${licence} is not on the release's allowlist`);
    });
  }
  return { findings, checked: changed.length };
}
