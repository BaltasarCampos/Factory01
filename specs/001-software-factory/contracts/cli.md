# Contract: `factory` command

All commands print unread Owner-inbox alerts first (FR-034a). Exit code 0 = success,
1 = refused (gate, signature, consent), 2 = usage error, 3 = environment error (missing `gh`,
`ssh-keygen`, network). "Laptop only" commands refuse when `CLAUDE_CODE_REMOTE` (or the
cloud marker confirmed in Phase 0) is set or when stdin is not a TTY.

| Command | Where | Effect | Spec |
|---------|-------|--------|------|
| `factory new "<pitch>" [--name <repo>]` | laptop | Consent prompt → choose `cloud`/`local` → verify the release tag's signature with the laptop's key list → create an **empty** private repo → `specify init` → write `.factory/` (pin `<tag>@<sha>`) → install guardrails from the pinned release → push a signed root commit → labels, CI workflows → pinned inbox issue → `claude/define` branch → local clone → start Define | FR-003, FR-004, AC-001, AC-003 |
| `factory adopt <owner/repo>` | laptop | Same as `new`, attaching to an existing repo: records `baseline` = main's last unsigned commit and makes a signed adopt commit after it; Define reads the code | FR-003, AC-007 |
| `factory run [--once]` | laptop | Run the dispatcher loop locally until an Owner gate, usage limit, cap or pause | FR-005 |
| `factory dispatch` | routine / laptop | One dispatcher pass: read state, verify records, derive pause state, start at most one session (or N if approved), apply label moves | FR-016, FR-016f, FR-027 |
| `factory approve <issue\|pr> [spec\|waiver <waives>]` | laptop only | Show approval summary (FR-043) → passphrase → sign record → post comment + event → apply `owner:` label | FR-007a |
| `factory merge <pr>` | laptop only | Refuse if main's first-parent history has an unsigned commit → warn+confirm if paused → refuse while a session for the item runs → record the checked head → per-branch checks computed on the laptop (data-model § Pull request merge checks); for an item, re-verify the whole approval chain + nonce ledger, and offer to re-sign any code-gate waiver whose `head` is stale, showing the diff → required CI checks green on the checked head → `git merge --no-ff -S <checked sha>` (passphrase) → push main (rejected if main moved) → close the PR if its head moved → delete the head branch | FR-007b, FR-016f, FR-016g, AC-014, AC-073, AC-081–AC-083, AC-086–AC-088 |
| `factory deploy` | laptop only | Refuse if main's first-parent history has an unsigned commit → warn+confirm if paused → passphrase → sign `deployed` record → re-verify chains of all items since last deploy → pull main, build, restart → ensure daily backup crontab entry → health summary | FR-007, AC-015, AC-087 |
| `factory config set <key> <value>` | laptop only | Change one `.factory/config` field (not `factory_release`) as a signed commit on main | FR-007f, AC-090 |
| `factory release <tag>` | laptop only (factory repo) | Show the diff since the last signed tag → Owner confirms → build `guardrails.manifest.json` → `git tag -s <tag>` (passphrase) → push the tag; the release workflow attaches the manifest, `allowed_signers` and `revoked_keys` | FR-007e, AC-083 |
| `factory pause [station]` | anywhere | Add `pause:line` / `pause:<station>` to inbox issue | FR-007c |
| `factory resume [station]` | laptop only | Read the scope's latest pause label-add time from the inbox timeline (warn if the laptop clock is > 60 s off GitHub's) → passphrase → sign resume record with `timestamp` = later of now and that time + 1 s → post to inbox → remove label | FR-007d |
| `factory upgrade <tag>` | laptop | Verify the tag's signature with main's pinned `allowed_signers` and resolve it to `<sha>` → branch `factory/upgrade-<tag>` with the release's guardrails + pin `<tag>@<sha>` → PR for the Owner → print `factory approve <pr> waiver check:guardrail-change@<tag>@<sha>`, then `factory merge <pr>`; if the release revokes a key, list in-flight items whose approvals used it | FR-006, AC-054, AC-083, AC-085 |
| `factory inbox [--all]` | laptop | List alerts; mark read | FR-034a |
| `factory mcp` | session (stdio) | Factory MCP server, see [mcp-tools.md](mcp-tools.md) | FR-022 |
| `factory hook <event>` | session | Hook entry point, see [hooks.md](hooks.md) | FR-021 |
| `factory ci <check>` | GitHub Actions | `test`, `lint`, `scan`, `coverage`, `red-green`, `size`, `ac-map`, `guardrail-change`, `append-only`, `new-deps`, `owner-alert`; built from the pinned release commit, using the release's configs | FR-038, FR-042, FR-048, FR-049 |
| `factory benchmark init` / `factory benchmark add <issue>` | laptop only | Create the private benchmark repo (signed root commit) / copy a merged item's issue text, spec, starting commit and expected gate outcomes to `items/<id>/` as a signed commit; Coach proposals are never adoptable below 5 items | FR-056, SC-009 |
| `factory keygen [--rotate [--finish]]` | laptop only | Create the Owner key with passphrase and configure git SSH signing; print the `allowed_signers` line (`namespaces="factory-approve,git"`) for the release + routine env. `--rotate` makes a new key; `--finish` deletes the old private key after the upgrade merge | FR-016e, AC-084 |
