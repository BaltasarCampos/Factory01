# Contract: factory MCP tools

Served by `factory mcp` over stdio, declared in each project's `.mcp.json` (guardrail file).
All inputs are validated; invalid input returns an MCP error and logs a `blocked` event.

## `advance_item`

Request that the dispatcher move an item to its next `state:`. Never moves labels itself.

```json
{ "item": 42, "from_state": "verifying", "evidence": "specs/42-add-login/reports/verify.md" }
```

Returns `{ "accepted": true, "request_id": "<ulid>" }` when the request event is written, or
`{ "accepted": false, "reason": "line paused" | "station paused" | "state mismatch" }`.
The dispatcher later checks the gate and any `owner:` record and applies or rejects the move
(FR-022, FR-029b).

## `log_event`

```json
{ "item": 42, "kind": "gate_result", "gate": "coverage", "pass": false,
  "evidence": "changed-line coverage 84%" }
```

Appends one Event ([data-model.md](../data-model.md#event)); `ts`, `role`, `session`, `model`
are filled from the session context, never from the caller. Secrets redacted.

## `request_split`

```json
{ "item": 42, "task": "T007", "reason": "context limit" | "size limit", "notes": "..." }
```

Logs a `split` event, marks the task returned to Plan, and the session must stop (FR-024,
AC-037, AC-057).
