// Guardrail manifest (data-model.md § Guardrail manifest, research R11, R19): the SHA-256 of
// every protected file a factory release installs. `factory release` builds it and puts it in
// the message of the signed release tag, which the tag signature covers. A commit cannot hold its
// own hash, so the manifest lives in the tag, not in the tree.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { RefusedError } from '../cli/env.js';
import { Fields, gh, repoArg, type GhOptions } from '../github/gh.js';
import type { GuardrailManifest, ReleasePin } from '../model/types.js';

export const MANIFEST_FILE = 'guardrails.manifest.json';

/** Hashed against the manifest (`.claude/hooks/**` is inside `.claude/**`). */
const HASHED_DIRS = ['.claude', '.github/workflows'] as const;
const HASHED_FILES = ['.mcp.json', '.specify/memory/constitution.md', '.factory/lockfile-policy'];

/** Protected but per project or never allowed to change, so not hashed. */
const UNHASHED_FILES = ['.factory/config'];
const UNHASHED_NAMES = ['.gitattributes', '.gitmodules'];

export class ManifestError extends RefusedError {}

function normalise(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/')).replace(/^\.\//, '');
}

export function isHashed(path: string): boolean {
  const p = normalise(path);
  return HASHED_FILES.includes(p) || HASHED_DIRS.some((dir) => p.startsWith(`${dir}/`));
}

/** True for a hashed path or a folder holding one: a symlink there would redirect the guards. */
export function coversHashed(path: string): boolean {
  const p = normalise(path);
  const roots = [...HASHED_DIRS, ...HASHED_FILES];
  return isHashed(p) || roots.some((root) => root === p || root.startsWith(`${p}/`));
}

/** True for every path an item or Define pull request may not touch. */
export function isProtected(path: string): boolean {
  const p = normalise(path);
  return isHashed(p) || UNHASHED_FILES.includes(p) || UNHASHED_NAMES.includes(posix.basename(p));
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Regular files under `root/rel`, as paths relative to `root`; a symlink is refused. */
function filesUnder(root: string, rel: string): string[] {
  let stat;
  try {
    stat = lstatSync(join(root, rel));
  } catch {
    return [];
  }
  if (stat.isSymbolicLink()) throw new ManifestError(`${rel}: a symlink in a protected path`);
  if (stat.isFile()) return [rel];
  if (!stat.isDirectory()) throw new ManifestError(`${rel}: not a regular file`);
  return readdirSync(join(root, rel)).flatMap((name) => filesUnder(root, posix.join(rel, name)));
}

/** The manifest of the protected files in the tree at `root`. */
export function buildManifest(root: string, release: ReleasePin): GuardrailManifest {
  const paths = [...HASHED_DIRS, ...HASHED_FILES].flatMap((p) => filesUnder(root, p)).sort();
  const files: Record<string, string> = {};
  for (const path of paths) files[path] = sha256(readFileSync(join(root, path)));
  return { release: release.tag, commit: release.sha, files };
}

/** Canonical JSON: fixed key order, files sorted by path, LF ending. */
export function serialiseManifest(manifest: GuardrailManifest): string {
  const files = Object.fromEntries(
    Object.entries(manifest.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return `${JSON.stringify({ release: manifest.release, commit: manifest.commit, files }, null, 2)}\n`;
}

/** Parse a manifest, or a tag message holding one before its signature block. */
export function parseManifest(text: string): GuardrailManifest {
  const body = text.split('-----BEGIN SSH SIGNATURE-----')[0] ?? '';
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ManifestError('the release tag message is not a guardrail manifest');
  }
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObject(value) || !isObject(value.files))
    throw new ManifestError('malformed guardrail manifest: no files');
  const { release, commit } = value;
  if (typeof release !== 'string' || typeof commit !== 'string')
    throw new ManifestError('malformed guardrail manifest: no release or commit');
  const files: Record<string, string> = {};
  for (const [path, hash] of Object.entries(value.files)) {
    if (!isHashed(path) || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))
      throw new ManifestError(`manifest entry ${JSON.stringify(path)} is not a guarded file`);
    files[path] = hash;
  }
  return { release, commit, files };
}

/** What differs between the release's files and an installed tree's; empty when equal. */
export function manifestMismatches(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): string[] {
  const paths = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  return paths.flatMap((path) => {
    if (actual[path] === undefined) return [`missing ${path}`];
    if (expected[path] === undefined) return [`not in the release: ${path}`];
    return expected[path] === actual[path] ? [] : [`changed ${path}`];
  });
}

/**
 * The manifest of the pinned release, read from its tag object in the public factory repo. The
 * tag must be annotated and still point at the pinned commit, and the manifest must name the
 * same tag and commit, so a moved or re-made tag is refused. Signature checks are
 * `verifyReleaseTag`'s job.
 */
export async function fetchPinnedManifest(
  factoryRepo: string,
  pin: ReleasePin,
  options: GhOptions = {},
): Promise<GuardrailManifest> {
  if (!/^v\d+\.\d+\.\d+$/.test(pin.tag) || !/^[0-9a-f]{40}$/.test(pin.sha))
    throw new ManifestError(`invalid release pin ${pin.tag}@${pin.sha}`);
  const base = `repos/${repoArg(factoryRepo)}/git`;
  const ref = Fields.of(
    await gh(['api', `${base}/ref/tags/${pin.tag}`], { ...options, json: true }),
    'tag ref',
  ).field('object');
  if (ref.str('type') !== 'tag')
    throw new ManifestError(`${pin.tag} is a lightweight tag; releases are signed tags`);
  const tagSha = ref.str('sha');
  if (!/^[0-9a-f]{40}$/.test(tagSha)) throw new ManifestError(`${pin.tag}: bad tag object id`);

  const tag = Fields.of(
    await gh(['api', `${base}/tags/${tagSha}`], { ...options, json: true }),
    'tag',
  );
  const target = tag.field('object');
  if (target.str('type') !== 'commit' || target.str('sha') !== pin.sha)
    throw new ManifestError(`${pin.tag} no longer points at the pinned commit ${pin.sha}`);

  const manifest = parseManifest(tag.str('message'));
  if (manifest.release !== pin.tag || manifest.commit !== pin.sha)
    throw new ManifestError(
      `the manifest in ${pin.tag} is for ${manifest.release}@${manifest.commit}, not the pin`,
    );
  return manifest;
}
