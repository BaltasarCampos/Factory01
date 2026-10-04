// Template renderer (plan.md § Project Structure): copies a release's `factory/` material into a
// project at the guardrail paths. Guardrail files are copied byte for byte, so they match the
// release manifest; `{{name}}` placeholders are filled only in the other files. Any protected
// file the release does not ship (for example Spec Kit's own `.claude/skills/`) is removed, so
// the project's protected set is exactly the release's.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { buildManifest, isHashed, ManifestError } from './manifest.js';

export type RenderVars = Readonly<Record<string, string>>;

/** `.mcp.json`: the factory MCP server, run as `factory mcp` over stdio. */
export const MCP_JSON = `${JSON.stringify(
  { mcpServers: { factory: { command: 'factory', args: ['mcp'] } } },
  null,
  2,
)}\n`;

interface Mapping {
  /** Under the release's `factory/` directory: a file, or a directory copied recursively. */
  from: string;
  to: string;
  required?: boolean;
}

const MAPPINGS: readonly Mapping[] = [
  { from: 'roles', to: '.claude/agents' },
  { from: 'skills', to: '.claude/skills' },
  { from: 'settings/settings.json', to: '.claude/settings.json', required: true },
  { from: 'workflows', to: '.github/workflows' },
  { from: 'constitution.md', to: '.specify/memory/constitution.md', required: true },
  { from: 'speckit', to: '.specify/templates/overrides' },
  { from: 'lockfile-policy', to: '.factory/lockfile-policy' },
];

function sourceFiles(root: string, rel: string): string[] {
  const full = join(root, rel);
  const stat = lstatSync(full);
  if (stat.isSymbolicLink()) throw new ManifestError(`factory/${rel}: symlinks are not shipped`);
  if (stat.isFile()) return [rel];
  return readdirSync(full).flatMap((name) => sourceFiles(root, posix.join(rel, name)));
}

function fill(text: string, vars: RenderVars): string {
  return text.replace(/\{\{([a-z_]+)\}\}/g, (match, name: string) => vars[name] ?? match);
}

/** Project path → content of every file the release installs. */
export function renderTree(factoryRoot: string, vars: RenderVars): Map<string, Buffer> {
  const out = new Map<string, Buffer>([['.mcp.json', Buffer.from(MCP_JSON)]]);
  for (const { from, to, required } of MAPPINGS) {
    if (!existsSync(join(factoryRoot, from))) {
      if (required) throw new ManifestError(`the factory release has no factory/${from}`);
      continue;
    }
    for (const rel of sourceFiles(factoryRoot, from)) {
      const target = rel === from ? to : posix.join(to, posix.relative(from, rel));
      const bytes = readFileSync(join(factoryRoot, rel));
      out.set(target, isHashed(target) ? bytes : Buffer.from(fill(bytes.toString('utf8'), vars)));
    }
  }
  return out;
}

/** Write the release into `projectRoot`; returns the written paths and the removed ones. */
export function render(
  factoryRoot: string,
  projectRoot: string,
  vars: RenderVars,
): { written: string[]; removed: string[] } {
  const tree = renderTree(factoryRoot, vars);
  const removed = Object.keys(buildManifest(projectRoot, { tag: '', sha: '' }).files).filter(
    (path) => !tree.has(path),
  );
  for (const path of removed) {
    rmSync(join(projectRoot, path));
    for (let dir = posix.dirname(path); dir !== '.'; dir = posix.dirname(dir)) {
      if (readdirSync(join(projectRoot, dir)).length > 0) break;
      rmdirSync(join(projectRoot, dir));
    }
  }
  for (const [path, bytes] of tree) {
    mkdirSync(dirname(join(projectRoot, path)), { recursive: true });
    writeFileSync(join(projectRoot, path), bytes);
  }
  return { written: [...tree.keys()].sort(), removed };
}
