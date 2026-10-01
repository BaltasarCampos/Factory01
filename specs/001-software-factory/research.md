# Research: Software Factory v1

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-10-01

Each entry resolves an unknown from the plan's Technical Context. Items the source marks
"checked in Phase 0" (§17) get a working decision here plus the probe that confirms it; the
probes are tasks in Phase 0 and their results amend this file.

---

## R1. Runtime and language version

- **Decision**: TypeScript 5.x, compiled with `tsc` to ESM, on Node.js 24 LTS (laptop already
  runs v24.14.1; cloud setup script pins the same major).
- **Rationale**: TypeScript is the only approved profile (constitution, Operating Constraints).
  Node 24 ships `node:util.parseArgs`, `node:test`-free built-ins we need (`node:crypto`,
  `node:child_process`, `node:sqlite` for product skeletons) so we avoid dependencies.
- **Alternatives**: Node 22 LTS (works, but the laptop is already on 24; one version
  everywhere is simpler); Bun/Deno (not in the approved profile).

## R2. CLI argument parsing

- **Decision**: `node:util.parseArgs` plus a small hand-written sub-command table.
- **Rationale**: Principle V order — standard library before dependency. The command surface
  is ~12 verbs with few flags.
- **Alternatives**: commander / yargs (fine, but unnecessary dependency and supply-chain
  surface).

## R3. GitHub access

- **Decision**: Shell out to the `gh` CLI (`gh issue`, `gh pr`, `gh api`) through one typed
  wrapper (`src/github/gh.ts`) that parses `--json` output. Label history comes from
  `gh api repos/{owner}/{repo}/issues/{n}/timeline --paginate` (`labeled` / `unlabeled`
  events with `created_at`).
- **Rationale**: Cloud sessions authenticate `gh` through the provider's proxy (SEC-0.2), so
  no token ever enters the factory's code; the same wrapper works on the laptop. Roles'
  shell allowlists are already written in `gh` terms (§6.2).
- **Alternatives**: Octokit (needs a token in-process — conflicts with SEC-0.2/0.3).
- **Prerequisite found**: `gh` is not installed on the laptop yet; quickstart lists it.

## R4. Signed approval and resume records

- **Decision**: Records are canonical text payloads signed with
  `ssh-keygen -Y sign -n factory-approve -f <key>`; verified with
  `ssh-keygen -Y verify -n factory-approve -I owner -f <allowed_signers> -s <sig>`, decided by
  exit code only. Payload format, fields and canonicalisation are in
  [data-model.md](data-model.md#approval-record) and
  [contracts/approval-record.md](contracts/approval-record.md).
- **Two-copy key check (FR-016e)**: the verifier builds `allowed_signers` from the pinned
  release file **and** `FACTORY_ALLOWED_SIGNERS` (routine env) / the laptop's own copy, and
  refuses unless the two public keys are byte-identical after whitespace normalisation.
- **Replay (AC-079)**: a nonce is 128 random bits (hex). Verification is stateless and derived
  from history: across all records on the item (and on the inbox issue for resumes), each
  nonce may back exactly one label-add event — the first one after the record's comment
  timestamp. A second use of the same nonce fails. The laptop additionally keeps
  `~/.factory/nonces.log` of nonces it has issued and seen, so `factory merge` rejects a
  replay even if GitHub history were edited.
- **Spec binding (AC-071)**: spec approval binds the blob hash of `spec.md`
  (`git rev-parse <branch>:specs/<feature>/spec.md`), which changes whenever the file changes;
  this is stricter and simpler than a commit hash and is what "commit hash of spec.md" is
  taken to mean. Interpretation approved by the Owner on 2026-10-01.
- **Key never unlocked (FR-016e)**: `factory approve` runs `ssh-keygen -Y sign` directly
  against the key file (passphrase prompted on the TTY); no `ssh-agent`.
- **Alternatives**: GPG signing (heavier, agent-based); signed git tags (bind to commits, not
  to issue/gate); GitHub's own review approvals (agents act as the Owner, so unforgeable only
  with a second account — rejected by constraints).
- **Phase 0 probe**: `ssh-keygen -Y verify` exists in the cloud image (OpenSSH ≥ 8.2; laptop
  has 9.2p1); forged, edited, cross-item and replayed records rejected by `factory dispatch`
  and `factory merge`.

## R5. How hooks know the role and the item branch

- **Decision**: The dispatcher launches every session with the role's agent definition
  (`--agent <role>`) and a station prompt. Hooks read the role from the hook input's agent
  field; the item branch and file list come from a **session manifest** the dispatcher
  commits to the item branch at `specs/<feature>/.station.json` before launching (path-guarded:
  no role may write it). If the role cannot be determined, hooks fail closed to the
  read-only profile.
- **Rationale**: Neither the prompt nor environment variables of a cloud session are a
  trustworthy carrier — an agent could re-read and reinterpret the prompt. A dispatcher-written
  file that no role can edit is checkable by deterministic code.
- **Alternatives**: Parse the branch from the prompt (agent-influenced); per-role cloud
  environments (would multiply environments and routine config).
- **Phase 0 probe**: confirm the exact hook-input field that carries the agent type in the
  installed Claude Code, and that `--agent` applies in cloud sessions.

## R6. Command guard design

- **Decision**: Per-role **allowlist** of command prefixes (from §6.2) with a deny list
  checked first (push to main/other branch, `gh pr merge`, label changes on `owner:` /
  `state:`, removing `pause:`, reads of `.env*`, secret stores, the approval-key path). The
  guard tokenises the Bash command with a small hand-written POSIX tokenizer; any construct it
  cannot fully analyse (command substitution, `eval`, `sh -c`, here-docs feeding a shell,
  backgrounding, aliases, `xargs` into git/gh) is **denied**. Every block is logged as an
  event.
- **Rationale**: Routines run without permission prompts (FR-6.3), so the guard is the
  enforcement; fail-closed is the only safe default for a tier 3 control.
- **Alternatives**: `shell-quote` / `bash-parser` packages (dependency for a small, security-
  critical parser we want to own and property-test); deny-only lists (bypassable).
- **Defence in depth**: `.claude/settings.json` deny rules duplicate the critical denials so
  the settings layer still blocks if a hook script fails to load.

## R7. Factory MCP server

- **Decision**: One stdio MCP server (`factory mcp`) using `@modelcontextprotocol/sdk`,
  declared in `.mcp.json`, exposing `advance_item`, `log_event`, `request_split`
  ([contracts/mcp-tools.md](contracts/mcp-tools.md)). `advance_item` does not move labels
  itself in a cloud session; it writes a structured request event and returns; the
  dispatcher's code applies the move after checking the gate and signatures.
- **Rationale**: FR-022 requires the dispatcher, not the session, to decide. Keeping label
  writes in the dispatcher avoids giving sessions a code path to `state:` labels.
- **Alternatives**: Hand-written JSON-RPC over stdio (saves one dependency but re-implements
  a protocol that evolves; the SDK is the established choice).

## R8. Session launch (cloud and local)

- **Decision**: A `SessionLauncher` interface with two implementations:
  `CloudLauncher` (Claude Code cloud session for the project's repo and item branch) and
  `LocalLauncher` (`claude -p --agent <role> --model sonnet "<prompt>"` in the laptop working
  copy). The dispatcher chooses by `.factory/config` `agents:` and cloud availability.
- **Rationale**: FR-031 requires the same prompts locally; an interface keeps the dispatcher
  testable with a fake launcher.
- **Open**: the exact cloud-launch invocation (source says `claude --cloud`) is confirmed in
  Phase 0; only `CloudLauncher` changes.

## R9. Spec Kit integration (FR-016a, FR-026)

- **Decision**: The installed Spec Kit (1.0.13) selects its feature from
  `SPECIFY_FEATURE` / `SPECIFY_FEATURE_DIRECTORY` or `.specify/feature.json`. When it creates
  the item branch, the dispatcher commits `.specify/feature.json` with
  `{"feature_directory": "specs/<issue>-<slug>"}` on that branch and sets both env vars for
  local sessions. `/speckit-specify` then writes into the existing folder instead of creating
  a branch.
- **Command form**: the installed version exposes hyphenated skills (`/speckit-specify`);
  station prompts and role files use that form, and the constitution table is aligned by a
  PATCH amendment (FR-026). Recorded as a Phase 0 finding.
- **Phase 0 probe**: run `/speckit-specify` on a dispatcher-created branch and confirm no new
  branch or folder is made.

## R10. Owner notification

- **Decision**: `src/notify/` writes every alert as a comment on the pinned Owner inbox issue
  (with an `unread` marker the laptop clears). Urgent alerts additionally run
  `gh workflow run owner-alert.yml -f alert_id=<id>`; the workflow fails on purpose so GitHub
  emails the Owner. Every `factory` command first prints unread alerts.
- **Phase 0 probe**: confirm a `workflow_dispatch` started from a routine (acting as the
  Owner) triggers GitHub's failed-run email.

## R11. Guardrail integrity

- **Decision**: Each factory release carries `guardrails.manifest.json` (path → sha256) built
  in the release workflow. The session-start hook hashes the project's guardrail files and
  compares them to the manifest **fetched from the pinned tag of the public factory repo**
  (not the project's own copy), so tampering with both the files and the local manifest is
  still caught. Mismatch → stop session, urgent alert.
- **CI `guardrail-change`**: fails any PR whose diff touches a protected path unless the PR
  carries a signed `owner:waiver` record for that PR (same verifier as R4).

## R12. Append-only logs

- **Decision**: CI job `append-only` on pushes to `claude/factory-log` and on PRs touching
  `specs/**/events.jsonl`: for every file present at the base, the head content must start
  with the base content byte-for-byte; deleted files fail. Implemented as `factory ci
  append-only <base> <head>`.

## R13. Quality checks owned by the factory

- **Changed-line coverage (QG-3)**: `factory ci coverage --min 90` intersects
  `git diff -U0 base...head` with Vitest's lcov output (`@vitest/coverage-v8`). Avoids a
  Python dependency such as diff-cover.
- **Size limit (QG-6)**: `factory ci size --max 400` counts changed lines excluding
  `specs/**`, lockfiles and generated files.
- **AC → test mapping (QG-2)**: tests carry `AC-###` in their `describe`/`it` titles;
  `factory ci ac-map` parses the spec's AC IDs and Vitest's JSON reporter and fails on any AC
  without a passing test.
- **New-dependency gate**: `factory ci new-deps` reads added packages from the lockfile diff,
  queries the npm registry (existence, first-publish date ≥ 90 days, weekly downloads) and
  flags Damerau–Levenshtein distance ≤ 2 to a bundled top-packages list. Pass → still waits for
  Owner approval.

## R14. Formal verification of the critical property

- **Decision**: A TLA+ specification `formal/Dispatcher.tla` models item states, `owner:`
  labels with signed/unsigned records, agent actions (including forging labels, removing
  pause labels, replaying records) and Owner actions. TLC checks the invariants
  `NoMergeWithoutOwner`, `NoDeployWithoutOwner`, `PausedLineNeverAdvances`,
  `GateOnlyOnOwnLabel`. CI runs TLC from `tla2tools.jar` (Java on GitHub-hosted runners).
- **Rationale**: Constitution III, tier 3, QG-7: TLA+ for workflows and state machines. The
  TypeScript transition table (`src/dispatcher/transitions.ts`) is property-tested with
  fast-check against the same invariants so model and code cannot drift silently.
- **Alternatives**: Dafny (better for small functions, not concurrent workflows).

## R15. Storage

- **Decision**: The factory itself keeps no database. State lives in GitHub (issues, labels,
  comments, PRs) and in repository files (`events.jsonl`, `.factory/`, `claude/factory-log`).
  The laptop keeps `~/.factory/` (nonce ledger, read-alert markers, deploy history). The
  TypeScript profile's walking skeleton uses `node:sqlite` (built in) for the product.
- **Rationale**: One source of truth, auditable, no extra service (Principle V).

## R16. Telemetry from cloud sessions

- **Decision**: Not depended on in v1. Usage per item is recorded by the `log_event` hook
  from session metadata; OpenTelemetry export is a Phase 0 probe that, if it works, adds
  prompt/response traces (closes the §19 gap) without design changes.

## R17. Throwaway sample project and benchmark

- **Decision**: Phase 0 uses a private throwaway repo `factory-sample-<date>` created by
  `factory new`. The benchmark repo is created empty in Phase 2; Gate C needs ≥ 5 items.

---

## Deferred to shadow-mode data (not blocking)

Token budgets per role, CLAUDE.md size, retry count (default 3, configurable in
`.factory/config`), security fix targets, metric targets, Gate B threshold, advisor payoff,
actual routine daily cap. All are config values with defaults; none changes the design.
