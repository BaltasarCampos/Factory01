# Contract: hooks

Registered in `.claude/settings.json` (guardrail file); each runs `factory hook <event>` and
reads the Claude Code hook JSON on stdin. Exit 2 = block (reason on stderr); exit 0 = allow.
Any internal error → block (fail closed).

| Hook event | Command | Checks | Spec |
|------------|---------|--------|------|
| `SessionStart` | `factory hook session-start` | What needs no git, against the session's record under `~/.factory/sessions/<session_id>/`, which the launcher writes: `FACTORY_ROLE` is its role, `FACTORY_ITEM` its item (unset for none), `FACTORY_STATION` its station, the input's `agent_type` its role, its `permission_mode` `dontAsk` or missing (Claude Code 2.1.322's SessionStart input carries none; the launcher's init check and the gate hold the mode, Owner decision 2026-11-11), and the hook input's `cwd`, by its real path, the record's clone. Passed → `passed.json` beside the record, written to a temporary file in the same folder and renamed into place, which every `PreToolUse` guard requires; failed, or a missing or malformed record → `passed.json` removed, a `blocked` event in the session's log, exit 2 (the session goes on, every tool call refused). Runs again after a compaction or a resume. The git-history checks (the branch's own commits change no protected path; the merge base's guardrails match the release pinned at the merge base) run in the launcher before launch (slice 28-2b); the model is checked from the stream's init message (T061); the pause state at issue time by the dispatcher (Owner decisions 2026-10-26 and 2026-10-27) | FR-021, AC-021 |
| `PreToolUse` (every tool, matcher `*`) | `factory hook gate` | Only the session-start record and the mode: no `passed.json` for the session, or `permission_mode` not `dontAsk`, a missing one included → block. So the subagent tool (`Task`, `Agent`), every `mcp__` tool and any tool a later Claude Code adds are refused until the start check passes; each guard below runs the same two checks first, and the factory MCP server refuses every call without `passed.json` itself (contracts/mcp-tools.md) | T086 |
| `PreToolUse` (Write, Edit) | `factory hook path-guard` | Path inside role's writable folders **and** (Builder/Test) the task file list; never a guardrail path, `.station.json`, approval-key path, `.env*`, `events.jsonl`, `.factory/events/**` | AC-018, AC-019 |
| `PreToolUse` (Read, Grep, Glob) | `factory hook read-guard` | Never a path `deny_read` names (approval-key path, `.env*`, secret stores, `~/.factory/`), by the named path or its real location; never a search folder holding a home path it names; every Grep that gives a `glob` refused, since ripgrep's `--glob` overrides its ignore and hidden-file rules; a Glob's `pattern` checked too: its leading part without glob characters, from `path` or `cwd`, checked as the search folder, and refused when not plain (a backslash, `(` or `)`, a leading `!`, empty), absolute (`/` or `~`), leaving the clone with `..`, holding `..` after a glob character or braces, or matched by a relative `deny_read` pattern; the Reviewer never reads the event logs nor greps a folder holding them | AC-074, T085 |
| `PreToolUse` (Bash) | `factory hook command-guard` | Role allowlist; deny: push to main / other branch, `gh pr merge`, `owner:`/`state:` label add/remove, `pause:` label removal, secret reads, any invocation of `factory approve\|merge\|deploy\|resume\|keygen` (any path or wrapper) or `ssh-keygen -Y sign`, unparseable constructs | AC-022, AC-067, AC-080 |
| `PostToolUse` (Write, Edit) | `factory hook post-edit` | Format (Prettier) and type-check touched TS file; report errors to the session | FR-021 |
| `PostToolUse` (all) | `factory hook log` | Append one Event to the session's own log, its facts from the session's record; a missing or malformed record blocks | FR-021, AC-048 |
| `Stop` | `factory hook stop` | The record's station's output at the session's head exists and passes its completeness check, Intake's against the record's repository and item; else block stop and log it in the session's log. No factory git runs in the session's clone: git reads it only inside the factory's bubblewrap sandbox, the clone read-only and nothing writable, and sends a full pack of what the session added since the record's head on its stdout, capped at 64 MiB; the factory indexes it with `index-pack --strict` in a quarantine under the session's own folder, checks there that the head is a commit of the pack, asked of the quarantine alone with no alternate (`cat-file --batch-check`, slice D-1a), whose history back to the record's head is whole, and only then moves the pack into the record's `project`, the factory's own clone, and keeps the commit under `refs/factory/sessions/<id>`, where the checks read it. Each git call is bounded at 120 s. A head that fails those checks blocks the stop with the reason; a failure of the factory's clone or of bubblewrap fails the hook (slice 28-5a) | AC-063 |
| `PreCompact` | `factory hook pre-compact` | Log, call request_split path, instruct stop | AC-037 |

Every block writes a `blocked` Event with role, tool, and the rule that fired.

The session's record is malformed, and every hook reading it blocks, when a field is missing or
of the wrong type, a field an event takes from it fails the event schema's own check (`role`,
`item`, `station`, `role_version` and `model`, never a Fable model), or its station is not its
role's: each role works
at one station, Verify's Test, Reviewer and Security at 5 and the Coach at Operate's 8.

**Limits.** Hooks run as the same user, on the same machine, as everything the agent runs.
The path guard sees only the Write and Edit tools; an agent with Bash can write files through
`git apply`, `tee`, `sed -i` or a script, and the command guard cannot analyse every program.
So for roles with a shell, path rules are defence in depth. The enforcement that holds is on
the laptop: `factory merge` checks protected paths on every pull request, and signed records
and main's signed history decide what counts (data-model § Pull request merge checks).
