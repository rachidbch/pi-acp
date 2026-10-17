# Changelog

## [0.0.36] - 2026-10-17

### New Features

- **Complete session lifecycle**: `session/list`, `session/resume`, `session/delete` and `session/close`; session browsing enables a picker in clients that support it.
- **Scoped request cancellation**: `$/cancel_request` cancels exactly one request; queued prompts in the same session keep running.
- **Session fork**: `session/fork` branches a stored pi session file into a new session using pi's native `--fork` (unstable).
- **Per-turn token usage**: `PromptResponse.usage` reports tokens derived from pi context snapshots taken around the turn (unstable). Usage is omitted after compaction resets, on missing stats, and on cancelled or failed turns; real cost continues to flow via `usage_update`.
- **Compaction, notices, and auth negotiation**: client-capability-gated compaction updates and session notices; provider failures surface as `AUTH_REQUIRED` so clients can offer terminal login.
- **Dead-process recovery with a crash guard**: a dead session's process respawns on the next request, bounded by a per-session budget (default 3 attempts per 10 minutes, env-tunable) with strike isolation, so a crash-looping session cannot spin or lock out others.

### Added

- Keep-alive for quiet in-flight turns: a no-op session update every 75 seconds guards against hosts that recycle idle agent processes (`PI_ACP_KEEPALIVE_MS=0` disables).
- Tool kinds now use the full ACP enum (`search`, `delete`, `move`, `fetch`, `think`) for correct client UI instead of collapsing to `other`.
- JSON-RPC boundary contract tests: unknown methods answer with errors, malformed params are rejected before handlers run, unknown capability fields are tolerated.
- Golden wire round-trip test validating every emitted session update against the SDK client parser.

### Changed

- Upgraded `@agentclientprotocol/sdk` from 0.26.0 to 1.9.0.
- `additionalDirectories` on session requests is accepted but ignored with a stderr warning; the capability is not advertised because pi uses a single working directory per session.
- Documented the provider and auth posture: `providers/list` returns an empty list (pi manages providers), `authenticate` is a no-op, `logout` is not advertised.

### Fixed

- Fixed `session/new` and `session/load` interrupting an in-flight turn of another thread sharing the same ACP connection; the sweep now skips busy sessions.
- Fixed stdin write failures to the pi child being reported as generic internal errors instead of process exit; shutdown paths are covered by hermetic tests.

## [0.0.35] - 2026-10-16

### New Features

- **Client MCP servers forwarded into pi**: ACP `mcpServers` are injected via a bundled pi extension using pi's native registration API; unsupported transports degrade gracefully without killing the session.
- **Extension prompts as ACP elicitation**: pi extension input and editor dialogs surface through `elicitation/create`, so extension UI works inside ACP clients.
- **Extension commands finish cleanly**: turns handled by extension commands (no agent loop) complete via the prompt disposition instead of hanging.
- **Structured tool results**: pi tool output is projected as ACP content blocks instead of flattened text.
- **Live bash output**: running shell commands stream terminal output to clients that advertise terminal support, with `rawOutput` carried on completion.
- **Thinking streamed**: reasoning deltas are emitted as `agent_thought_chunk` alongside `agent_message_chunk`.
- **Provider and auth discovery**: `providers/list` is answered and an auth-status push (`_auth/status_update`) lets clients discover credentials before creating a session.

### Fixed

- Fixed advertised model display names colliding with model ids, which some client preference stores reject.
- Fixed event handlers not being notified when the pi child process dies.
- Fixed pi child lifecycle and shutdown: children are disposed and the adapter exits cleanly on client disconnect.
- Fixed RPC integration robustness: response validation, startup event buffering, LF-only stream framing.
- Fixed adapter built-in command descriptions being lost on name conflicts with extension commands.

### Changed

- Published as `@razorbackdb/pi-acp`; package metadata points at this fork. Git installs build the bundle via a `prepare` script.
