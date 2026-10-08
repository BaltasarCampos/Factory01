# Contract: factory MCP tools

Served by `factory mcp` over stdio, declared in each project's `.mcp.json` (guardrail file).
All inputs are validated; invalid input returns an MCP error and logs a `blocked` event.

The session context (role, session id, item, station, model, role version and event log) is
the one its hooks resolve. A hook reads the role and session id from its input; the MCP server
reads them from `FACTORY_ROLE` and `FACTORY_SESSION`, which the launcher sets, and refuses to
serve without them. An `item` other than the session's is invalid input.

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
are filled from the session context, never from the caller. Secrets redacted. `kind` is one of
`tool_call`, `gate_result` or `usage`, the kinds a session originates; approvals, alerts, Owner
comments and caps come from the Owner and the dispatcher, and `split` and `advance_request`
have their own tools. These events are telemetry: they never count toward a gate or a retry.

## `request_split`

```json
{ "item": 42, "task": "T007", "reason": "context limit" | "size limit", "notes": "..." }
```

Logs a `split` event, marks the task returned to Plan, and the session must stop (FR-024,
AC-037, AC-057).
