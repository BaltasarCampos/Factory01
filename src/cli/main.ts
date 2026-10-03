#!/usr/bin/env node
// `factory` entry point: wires the real process to runCli.
import { runCli } from './commands.js';

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  stdinIsTTY: process.stdin.isTTY,
  // Replaced by the Owner-inbox reader in T030 (slice 6).
  unreadAlerts: () => Promise.resolve([]),
});
