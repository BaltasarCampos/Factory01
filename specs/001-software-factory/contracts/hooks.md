# Contract: hooks

Registered in `.claude/settings.json` (guardrail file); each runs `factory hook <event>` and
reads the Claude Code hook JSON on stdin. Exit 2 = block (reason on stderr); exit 0 = allow.
Any internal error → block (fail closed).

| Hook event | Command | Checks | Spec |
|------------|---------|--------|------|
| `SessionStart` | `factory hook session-start` | What needs no git, against the session's record under `~/.factory/sessions/<session_id>/`, which the launcher writes: `FACTORY_ROLE` is its role, `FACTORY_ITEM` its item (unset for none), `FACTORY_STATION` its station, the input's `agent_type` its role and `permission_mode` `dontAsk`. the hook input's `cwd`, by its real path, the record's clone. Passed → `passed.json` beside the record, written to a temporary file in the same folder and renamed into place, which every `PreToolUse` guard requires; failed, or a missing or malformed record → `passed.json` removed, a `blocked` event in the session's log, exit 2 (the session goes on, every tool call refused). Runs again after a compaction or a resume. The git-history checks (the branch's own commits change no protected path; the merge base's guardrails match the release pinned at the merge base) run in the launcher before launch (slice 28-2b); the model is checked from the stream's init message (T061); the pause state at issue time by the dispatcher (Owner decisions 2026-10-26 and 2026-10-27) | FR-021, AC-021 |
| `PreToolUse` (every tool, matcher `*`) | `factory hook gate` | Only the session-start record and the mode: no `passed.json` for the session, or `permission_mode` not `dontAsk` → block. So the subagent tool (`Task`, `Agent`), every `mcp__` tool and any tool a later Claude Code adds are refused until the start check passes; each guard below runs the same two checks first, and the factory MCP server refuses every call without `passed.json` itself (contracts/mcp-tools.md) | T086 |
| `PreToolUse` (Write, Edit) | `factory hook path-guard` | Path inside role's writable folders **and** (Builder/Test) the task file list; never a guardrail path, `.station.json`, approval-key path, `.env*`, `events.jsonl`, `.factory/events/**` | AC-018, AC-019 |
| `PreToolUse` (Read, Grep, Glob) | `factory hook read-guard` | Never a path `deny_read` names (approval-key path, `.env*`, secret stores, `~/.factory/`), by the named path or its real location; never a search folder holding a home path it names; every Grep that gives a `glob` refused, since ripgrep's `--glob` overrides its ignore and hidden-file rules; a Glob's `pattern` checked too: its leading part without glob characters, from `path` or `cwd`, checked as the search folder, and refused when not plain (a backslash, `(` or `)`, a leading `!`, empty), absolute (`/` or `~`), leaving the clone with `..`, holding `..` after a glob character or braces, or matched by a relative `deny_read` pattern; the Reviewer never reads the event logs nor greps a folder holding them | AC-074, T085 |
| `PreToolUse` (Bash) | `factory hook command-guard` | Role allowlist; deny: push to main / other branch, `gh pr merge`, `owner:`/`state:` label add/remove, `pause:` label removal, secret reads, any invocation of `factory approve\|merge\|deploy\|resume\|keygen` (any path or wrapper) or `ssh-keygen -Y sign`, unparseable constructs | AC-022, AC-067, AC-080 |
| `PostToolUse` (Write, Edit) | `factory hook post-edit` | Format (Prettier) and type-check touched TS file; report errors to the session | FR-021 |
| `PostToolUse` (all) | `factory hook log` | Append one Event to the session's own log, its facts from the session's record; a missing or malformed record blocks | FR-021, AC-048 |
| `Stop` | `factory hook stop` | The record's station's output, in the record's clone, exists and passes its completeness check, Intake's against the record's repository and item; else block stop and log it in the session's log | AC-063 |
| `PreCompact` | `factory hook pre-compact` | Log, call request_split path, instruct stop | AC-037 |

Every block writes a `blocked` Event with role, tool, and the rule that fired.

**Limits.** Hooks run as the same user, on the same machine, as everything the agent runs.
The path guard sees only the Write and Edit tools; an agent with Bash can write files through
`git apply`, `tee`, `sed -i` or a script, and the command guard cannot analyse every program.
So for roles with a shell, path rules are defence in depth. The enforcement that holds is on
the laptop: `factory merge` checks protected paths on every pull request, and signed records
and main's signed history decide what counts (data-model § Pull request merge checks).
