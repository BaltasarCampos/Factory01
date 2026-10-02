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
- **Keys and two-copy check (FR-016e, updated 2026-10-02)**: the release's `allowed_signers`
  lists every key ever used (`namespaces="factory-approve,git"`) and `revoked_keys` lists
  compromised ones, passed as `ssh-keygen -Y verify -r`. Both are always read from the release
  pinned on main, never a PR's copy. `FACTORY_ALLOWED_SIGNERS` (routine env) / the laptop's
  copy must equal the newest non-revoked key after whitespace normalisation; a mismatch right
  after an upgrade that added a key is reported as "key rotation pending", not tampering.
  Keeping old keys means no history lookup is needed to verify old records, and cloud
  sessions may clone shallow.
- **Replay (AC-079)**: a nonce is 128 random bits (hex). Verification is stateless and derived
  from history: across all records on the item, each `approved`/`spec-approved`/`waiver`
  nonce may back exactly one label-add event — the first one after the record's comment
  timestamp. A resume record lifts only pauses added before its signed `timestamp`, and
  `deployed` nonces must be first occurrences in the repo (contract step 6). Timestamps are set
  by the key holder, so they order records but prove nothing against a stolen key; that case
  is handled by revocation. A
  second use of the same nonce fails. The laptop additionally keeps
  `~/.factory/nonces.log` of nonces it has issued and seen, so `factory merge` rejects a
  replay even if GitHub history were edited.
- **Spec binding (AC-071)**: spec approval binds the blob hash of `spec.md`
  (`git rev-parse <branch>:specs/<feature>/spec.md`), which changes whenever the file changes;
  this is stricter and simpler than a commit hash and is what "commit hash of spec.md" is
  taken to mean. Interpretation approved by the Owner on 2026-10-01.
- **Key never unlocked (FR-016e)**: `factory approve` runs `ssh-keygen -Y sign` directly
  against the key file (passphrase prompted on the TTY); no `ssh-agent`.
- **Alternatives**: GPG signing (heavier, agent-based); signed git tags alone (bind to
  commits, not to issue/gate; used for releases instead, R19); GitHub's own review approvals (agents act as the Owner, so unforgeable only
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
  station prompts and role files use that form, and constitution v2.5.0 adopts it (FR-026).
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
  on the laptop by `factory release` and covered by the Owner's tag signature (R19). The
  session-start hook checks that the branch's own commits changed no protected file,
  `.gitattributes`, `.gitmodules` or `.factory/config`, and that the merge base's guardrail
  files match the manifest **fetched by the commit hash pinned in the merge base's config**
  (not the project's own copy, not by tag), so tampering with both the files and the local
  manifest is still caught. Checking against the merge base rather than main keeps in-flight
  items running after an upgrade; they pick up the new release at Integrate's rebase.
  Mismatch → stop session, urgent alert.
- **CI `guardrail-change`**: fails any item or Define PR touching a protected path,
  `.gitattributes`, `.gitmodules` or `.factory/config` (no waiver); an upgrade PR must equal
  the manifest of the release it names. Early feedback only: `factory merge` repeats the check
  on the laptop (R18).

## R12. Append-only logs

- **Decision**: CI job `append-only` on pushes to `claude/factory-log` and on PRs touching
  `specs/**/events.jsonl`: for every file present at the base, the head content must start
  with the base content byte-for-byte; deleted files fail. Implemented as `factory ci
  append-only <base> <head>`. On `claude/factory-log` it also enforces the allowed paths and
  regular text files only; `factory merge` repeats the whole check on the laptop (R18).
- **Trust**: append-only gives ordering, not authorship. Agents with a shell can write event
  lines with any `ts`, so the event log is telemetry and decides nothing (FR-028).

## R13. Quality checks owned by the factory

- **CI runs only release code (FR-048, 2026-10-02)**: workflows check out the factory repo at
  the commit pinned on main, build the CLI, and run `factory ci test|lint|scan|coverage|
  red-green|…` with configs and thresholds from `factory/profiles/typescript/ci/`. The PR's
  `package.json` scripts and tool configs are never used in CI.
- **Changed-line coverage (QG-3)**: `factory ci coverage` (threshold = the stricter of the
  release's floor, 90, and `coverage_min` in main's config) intersects
  `git diff -U0 --no-renames --no-ext-diff --no-textconv base...head` (`.gitattributes`
  ignored) with Vitest's lcov output (`@vitest/coverage-v8`). Avoids a
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
  `factory new`. The benchmark repo is created in Phase 2 with `factory benchmark init` and
  filled by the Owner with `factory benchmark add <issue>` from merged items; Gate C needs
  ≥ 5 items, and the replay runner marks no Coach proposal adoptable below that.

## R18. Laptop merge and signed main history (2026-10-02)

- **Problem**: GitHub runs `pull_request` workflows from the PR's own files, so CI can be made
  to pass by the PR it checks; agents act on GitHub as the Owner, so labels, tags and merges
  made through GitHub prove nothing; hooks share a user with the agent's shell.
- **Decision**: `factory merge` is the only merge path. On the laptop it computes the diff
  (`git -c core.attributesFile=/dev/null diff --no-renames --no-ext-diff --no-textconv`),
  applies the per-branch rules (data-model § Pull request merge checks), checks CI on the
  checked commit, then runs `git merge --no-ff -S <sha>` and pushes main. `gh pr merge` is
  not used: GitHub would sign the merge commit with its own key. A rejected push (main moved)
  aborts; a moved PR head is closed with a comment; merged item branches are deleted.
- **Signed history**: git SSH signing (`gpg.format ssh`, `user.signingkey` = Owner key,
  passphrase per signature, no agent). Every first-parent commit after `baseline` must pass
  `git verify-commit` against main's pinned `allowed_signers`. The dispatcher deepens its
  fetch of main's first-parent history to the baseline; the laptop verifies incrementally from
  `~/.factory/verified/<repo>`.
- **Baseline**: a commit cannot contain its own hash, so adopted repos record the last
  unsigned commit; `factory new` creates an empty repo and pushes a signed root commit, so
  GitHub's auto-generated commit never appears.
- **Replaces**: the `merged` record, `--record-only`, and "flag merges without a record".
- **Phase 0 probe**: `git verify-commit` with an SSH allowed-signers file works in the cloud
  image (git ≥ 2.34).

## R19. Release pinning and signed tags (2026-10-02)

- **Decision**: projects pin `<tag>@<sha>`. `factory release <tag>` (laptop, factory repo)
  shows the diff since the last signed tag, asks the Owner to confirm, builds the manifest and
  runs `git tag -s`. `factory upgrade` verifies the tag with main's pinned `allowed_signers`
  (for `factory new`, the laptop's key list) and records `<tag>@<sha>` in the waiver;
  `factory merge` refuses if the tag moved or the PR's protected set differs from the
  manifest at that commit. CI and session-start fetch the release by commit hash, so a moved
  tag never reaches them.
- **Rationale**: resolving a tag at upgrade time only catches moves after that moment; a
  signature catches a move at any time. Tag protection on GitHub cannot tell agents from the
  Owner.
- **Alternatives**: a separate release key (two keys to guard; namespaces already separate
  the uses); signing only the manifest file (does not bind the code the CLI is built from).

## R20. Red-green check and test quality (2026-10-02)

- **Decision**: `factory ci red-green` reads the AC IDs from the approved `spec.md`, finds
  tests whose titles carry them, runs them against the code at the merge base (head test
  files over base sources) and at the head. Each AC needs ≥ 1 tagged test failing at the base
  and passing at the head. Skipped if every changed file matches the release's test-path
  patterns; refactors need a `gate:red-green` waiver bound to the head. Replaces red/green
  events, which an agent could write.
- **Limit**: proves something changed, not that the right thing changed; a tagged test can
  fail at the base for an irrelevant reason (for example a missing import). The independent
  review remains the control.
- **Deferred option**: mutation testing (for example Stryker on changed files) would measure
  whether tests catch broken code; it costs CI minutes, so it is not in v1.

---

## Deferred to shadow-mode data (not blocking)

Token budgets per role, CLAUDE.md size, retry count (default 3, configurable in
`.factory/config`), security fix targets, metric targets, Gate B threshold, advisor payoff,
actual routine daily cap. All are config values with defaults; none changes the design.
