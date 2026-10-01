# Contract: `factory` command

All commands print unread Owner-inbox alerts first (FR-034a). Exit code 0 = success,
1 = refused (gate, signature, consent), 2 = usage error, 3 = environment error (missing `gh`,
`ssh-keygen`, network). "Laptop only" commands refuse when `CLAUDE_CODE_REMOTE` (or the
cloud marker confirmed in Phase 0) is set or when stdin is not a TTY.

| Command | Where | Effect | Spec |
|---------|-------|--------|------|
| `factory new "<pitch>" [--name <repo>]` | laptop | Consent prompt → choose `cloud`/`local` → create private repo → `specify init` → write `.factory/` → install guardrails from pinned release → labels, CI workflows → pinned inbox issue → local clone → start Define | FR-003, FR-004, AC-001, AC-003 |
| `factory adopt <owner/repo>` | laptop | Same as `new`, attaching to an existing repo; Define reads the code | FR-003, AC-007 |
| `factory run [--once]` | laptop | Run the dispatcher loop locally until an Owner gate, usage limit, cap or pause | FR-005 |
| `factory dispatch` | routine / laptop | One dispatcher pass: read state, verify records, derive pause state, start at most one session (or N if approved), apply label moves | FR-016, FR-016f, FR-027 |
| `factory approve <issue> [spec\|waiver <id>]` | laptop only | Show approval summary (FR-043) → passphrase → sign record → post comment + event → apply `owner:` label | FR-007a |
| `factory merge <pr>` | laptop only | Warn+confirm if paused → re-verify whole approval chain + nonce ledger → `gh pr merge` → write merge-verification record | FR-007b, AC-014 |
| `factory deploy` | laptop only | Warn+confirm if paused → re-verify chains of all items since last deploy → pull main, build, restart → health summary | FR-007, AC-015 |
| `factory pause [station]` | anywhere | Add `pause:line` / `pause:<station>` to inbox issue | FR-007c |
| `factory resume [station]` | laptop only | Passphrase → sign resume record → post to inbox → remove label | FR-007d |
| `factory upgrade <tag>` | laptop | Branch `factory/upgrade-<tag>` with new guardrails + pin → PR for Owner | FR-006, AC-054 |
| `factory inbox [--all]` | laptop | List alerts; mark read | FR-034a |
| `factory mcp` | session (stdio) | Factory MCP server, see [mcp-tools.md](mcp-tools.md) | FR-022 |
| `factory hook <event>` | session | Hook entry point, see [hooks.md](hooks.md) | FR-021 |
| `factory ci <check>` | GitHub Actions | `guardrail-change`, `append-only`, `coverage`, `size`, `ac-map`, `new-deps`, `owner-alert` | FR-038, FR-048 |
| `factory keygen` | laptop only | Create the approval key with passphrase; print public key for release + routine env | FR-016e |
