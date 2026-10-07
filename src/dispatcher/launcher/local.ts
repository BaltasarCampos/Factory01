// Local sessions (research R8, FR-031): `claude -p --agent <role> --model sonnet "<prompt>"` in
// the laptop working copy, one at a time. The launch resolves when the session ends, so
// `factory run` works the line one session after another. For an item branch, Spec Kit's
// feature is set through `SPECIFY_FEATURE` and `SPECIFY_FEATURE_DIRECTORY` (research R9).
import { spawn } from 'node:child_process';
import { EnvironmentError, RefusedError } from '../../cli/env.js';
import type { LaunchRequest, SessionLauncher } from './types.js';

export type Runner = (
  program: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ status: number | null; stdout: string; stderr: string }>;

export const runProcess: Runner = (program, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(program, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });

export class LocalLauncher implements SessionLauncher {
  readonly mode = 'local';
  private running = false;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: Runner;

  constructor(options: { cwd: string; env: NodeJS.ProcessEnv; run?: Runner }) {
    this.cwd = options.cwd;
    this.env = options.env;
    this.run = options.run ?? runProcess;
  }

  async available(): Promise<boolean> {
    try {
      const result = await this.run('claude', ['--version'], { cwd: this.cwd, env: this.env });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  async launch(request: LaunchRequest): Promise<{ sessionId: string }> {
    if (this.running) throw new RefusedError('a local session is already running');
    this.running = true;
    try {
      const feature = /^claude\/(\d+-[a-z0-9-]+)$/.exec(request.branch)?.[1];
      const env = {
        ...this.env,
        ...(feature === undefined
          ? {}
          : { SPECIFY_FEATURE: feature, SPECIFY_FEATURE_DIRECTORY: `specs/${feature}` }),
      };
      const args = ['-p', '--agent', request.role, '--model', 'sonnet', '--output-format', 'json'];
      const result = await this.run('claude', [...args, request.prompt], { cwd: this.cwd, env });
      if (result.status !== 0)
        throw new EnvironmentError(
          `claude exited ${String(result.status)}: ${result.stderr.trim()}`,
        );
      let sessionId: unknown;
      try {
        sessionId = (JSON.parse(result.stdout) as { session_id?: unknown }).session_id;
      } catch {
        sessionId = undefined;
      }
      if (typeof sessionId !== 'string') throw new EnvironmentError('claude printed no session_id');
      return { sessionId };
    } finally {
      this.running = false;
    }
  }
}
