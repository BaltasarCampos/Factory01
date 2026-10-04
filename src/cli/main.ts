#!/usr/bin/env node
// `factory` entry point: wires the real process to runCli.
import { projectUnreadAlerts } from '../notify/inbox.js';
import { runCli } from './commands.js';

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  stdinIsTTY: process.stdin.isTTY,
  unreadAlerts: () => projectUnreadAlerts(process.cwd(), process.env),
});
