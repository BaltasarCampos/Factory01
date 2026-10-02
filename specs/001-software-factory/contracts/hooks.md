# Contract: hooks

Registered in `.claude/settings.json` (guardrail file); each runs `factory hook <event>` and
reads the Claude Code hook JSON on stdin. Exit 2 = block (reason on stderr); exit 0 = allow.
Any internal error → block (fail closed).

| Hook event | Command | Checks | Spec |
|------------|---------|--------|------|
| `SessionStart` | `factory hook session-start` | (a) the branch's own commits (safe diff of merge base…HEAD) change no protected path, no `.gitattributes`/`.gitmodules` and not `.factory/config`; (b) the merge base's guardrail files match the manifest of the release pinned in the merge base's `.factory/config` (`<tag>@<sha>`, fetched by commit). An item branch created before an upgrade or `config set` keeps running on its release and picks up the new one at Integrate's rebase; existing `.gitattributes`/`.gitmodules` (for example in adopted repos) are allowed while unchanged; role resolvable; station manifest present and matching current branch (roles with `branch: item` only; others use their fixed branch from `roles.yaml`); pause state allows this station. Mismatch → stop + urgent alert | FR-021, AC-021 |
| `PreToolUse` (Write, Edit) | `factory hook path-guard` | Path inside role's writable folders **and** (Builder/Test) the task file list; never a guardrail path, `.station.json`, approval-key path, `.env*`, `events.jsonl`, `.factory/events/**` | AC-018, AC-019 |
| `PreToolUse` (Read, Grep, Glob) | `factory hook read-guard` | Deny approval-key path, `.env*`, secret stores | AC-074 |
| `PreToolUse` (Bash) | `factory hook command-guard` | Role allowlist; deny: push to main / other branch, `gh pr merge`, `owner:`/`state:` label add/remove, `pause:` label removal, secret reads, any invocation of `factory approve\|merge\|deploy\|resume\|keygen` (any path or wrapper) or `ssh-keygen -Y sign`, unparseable constructs | AC-022, AC-067, AC-080 |
| `PostToolUse` (Write, Edit) | `factory hook post-edit` | Format (Prettier) and type-check touched TS file; report errors to the session | FR-021 |
| `PostToolUse` (all) | `factory hook log` | Append one Event | FR-021, AC-048 |
| `Stop` | `factory hook stop` | Station output exists and passes its completeness check; else block stop | AC-063 |
| `PreCompact` | `factory hook pre-compact` | Log, call request_split path, instruct stop | AC-037 |

Every block writes a `blocked` Event with role, tool, and the rule that fired.

**Limits.** Hooks run as the same user, on the same machine, as everything the agent runs.
The path guard sees only the Write and Edit tools; an agent with Bash can write files through
`git apply`, `tee`, `sed -i` or a script, and the command guard cannot analyse every program.
So for roles with a shell, path rules are defence in depth. The enforcement that holds is on
the laptop: `factory merge` checks protected paths on every pull request, and signed records
and main's signed history decide what counts (data-model § Pull request merge checks).
