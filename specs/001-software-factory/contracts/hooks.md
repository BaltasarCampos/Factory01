# Contract: hooks

Registered in `.claude/settings.json` (guardrail file); each runs `factory hook <event>` and
reads the Claude Code hook JSON on stdin. Exit 2 = block (reason on stderr); exit 0 = allow.
Any internal error → block (fail closed).

| Hook event | Command | Checks | Spec |
|------------|---------|--------|------|
| `SessionStart` | `factory hook session-start` | Guardrail hashes vs pinned release manifest; role resolvable; station manifest present and matching current branch; pause state allows this station. Mismatch → stop + urgent alert | FR-021, AC-021 |
| `PreToolUse` (Write, Edit) | `factory hook path-guard` | Path inside role's writable folders **and** (Builder/Test) the task file list; never a guardrail path, `.station.json`, approval-key path, `.env*` | AC-018, AC-019 |
| `PreToolUse` (Read, Grep, Glob) | `factory hook read-guard` | Deny approval-key path, `.env*`, secret stores | AC-074 |
| `PreToolUse` (Bash) | `factory hook command-guard` | Role allowlist; deny: push to main / other branch, `gh pr merge`, `owner:`/`state:` label add/remove, `pause:` label removal, secret reads, unparseable constructs | AC-022, AC-067, AC-080 |
| `PostToolUse` (Write, Edit) | `factory hook post-edit` | Format (Prettier) and type-check touched TS file; report errors to the session | FR-021 |
| `PostToolUse` (all) | `factory hook log` | Append one Event | FR-021, AC-048 |
| `Stop` | `factory hook stop` | Station output exists and passes its completeness check; else block stop | AC-063 |
| `PreCompact` | `factory hook pre-compact` | Log, call request_split path, instruct stop | AC-037 |

Every block writes a `blocked` Event with role, tool, and the rule that fired.
