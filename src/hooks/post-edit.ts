// `factory hook post-edit` (PostToolUse Write|Edit, FR-021): format the touched TypeScript file
// with the project's Prettier and type-check it with the project's tsc. Problems go back to the
// session (exit 2 on PostToolUse shows the reason to the model; the edit itself stands).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HookError, type HookContext, type HookInput, type HookResult } from './log.js';

const TS_FILE = /\.(ts|tsx|mts|cts)$/;

function tool(cwd: string, name: string): string {
  const path = join(cwd, 'node_modules', '.bin', name);
  if (!existsSync(path)) throw new HookError(`${name} is not installed in ${cwd}; run npm ci`);
  return path;
}

/** tsc diagnostics for one file, with their continuation lines. */
function diagnosticsFor(output: string, cwd: string, file: string): string[] {
  const lines: string[] = [];
  let keep = false;
  for (const line of output.split('\n')) {
    const head = /^(.+?)\(\d+,\d+\): error TS\d+/.exec(line);
    // Errors in configuration (tsconfig.json, or none located) would otherwise pass every edit.
    if (head) keep = resolve(cwd, head[1] ?? '') === file || !TS_FILE.test(head[1] ?? '');
    else if (/^error TS\d+/.test(line)) keep = true;
    else if (!line.startsWith(' ')) keep = false;
    if (keep) lines.push(line);
  }
  return lines;
}

export function runPostEdit(input: HookInput, ctx: HookContext): Promise<HookResult> {
  const toolInput = input.tool_input as Record<string, unknown> | undefined;
  const target = toolInput?.file_path;
  if (typeof target !== 'string' || !TS_FILE.test(target)) return Promise.resolve({ block: false });
  const file = resolve(ctx.cwd, target);

  const format = spawnSync(tool(ctx.cwd, 'prettier'), ['--write', file], {
    cwd: ctx.cwd,
    encoding: 'utf8',
  });
  if (format.status !== 0) {
    return Promise.resolve({
      block: true,
      reason: `prettier failed on ${target}:\n${format.stderr}`,
    });
  }

  // The profile always ships one; without it tsc would load every @types package (minutes).
  const tsconfig = join(ctx.cwd, 'tsconfig.json');
  if (!existsSync(tsconfig))
    throw new HookError(`no tsconfig.json in ${ctx.cwd}; cannot type-check`);
  const args = ['--noEmit', '--pretty', 'false', '-p', tsconfig];
  const check = spawnSync(tool(ctx.cwd, 'tsc'), args, { cwd: ctx.cwd, encoding: 'utf8' });
  const errors = diagnosticsFor(`${check.stdout}${check.stderr}`, ctx.cwd, file);
  if (errors.length > 0) {
    return Promise.resolve({
      block: true,
      reason: `type errors in ${target}:\n${errors.join('\n')}`,
    });
  }
  return Promise.resolve({ block: false });
}
