<p align="center">
  <a href="https://github.com/razorbackdb/pi-acp">
    <img alt="pi-acp" src="https://img.shields.io/badge/pi--acp-ACP%20adapter-8A2BE2?style=flat-square" />
  </a>
  &nbsp;
  <a href="https://github.com/razorbackdb/pi-acp/releases">
    <img alt="release" src="https://img.shields.io/github/v/release/razorbackdb/pi-acp?style=flat-square&logo=github" />
  </a>
</p>

# pi-acp

pi-acp connects [Pi](https://github.com/earendil-works/pi) to any editor that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP): Zed, JetBrains IDEs, and other ACP-compatible clients.

One ACP session maps to one `pi --mode rpc` subprocess. The adapter translates ACP requests into pi RPC, streams pi's output back as session updates, and stays out of the way: Pi keeps managing its own providers, sessions, tools, and files locally.

Pi sessions created through the adapter live in `~/.pi/agent/sessions/` like any other Pi session, so you can resume them in the terminal with `pi --resume` and vice versa.

## Getting started

Install Pi, then install this adapter:

```bash
npm install -g @earendil-works/pi-coding-agent   # Pi itself
npm install -g razorbackdb/pi-acp                # this adapter (builds on install)
```

Requires Node.js 22+, `pi` on your `PATH`, and your model providers configured in Pi (`pi` in a terminal, then `/login`).

The npm package `pi-acp` and the ACP Registry entry serve the upstream adapter. For this fork's features, install from GitHub as above (or [from source](#development)).

### Zed

Add to `settings.json`:

```json
"agent_servers": {
  "pi": {
    "type": "custom",
    "command": "pi-acp",
    "args": [],
    "env": {}
  }
}
```

### Other ACP clients

Point the client at the installed `pi-acp` binary (or `node …/dist/index.js`). For JetBrains and other registry-capable editors, add it as a custom ACP agent server.

## What you get

- Full prompt streaming: assistant text as `agent_message_chunk`, thinking deltas as `agent_thought_chunk`, tool activity as `tool_call`/`tool_call_update` with locations and structured edit diffs
- Live terminal output for running shell commands (when the client advertises terminal support)
- Session lifecycle: `session/new`, `session/load`, `session/list`, `session/resume`, `session/fork`, `session/delete`, `session/close`. Load and resume find the pi session file from the session id and cwd in pi's own session directory (`PI_CODING_AGENT_SESSION_DIR`, then `settings.json` `sessionDir`, then `<agent dir>/sessions/--<cwd>--/`), with no adapter-side index. Requests for a session with no live process respawn it on demand, behind a per-session crash budget
- Scoped cancellation: `$/cancel_request` cancels one request; other queued prompts are unaffected
- Per-turn token usage (`PromptResponse.usage`, unstable) and context occupancy (`usage_update`) with real cost when Pi reports it
- Compaction, session notices, and auth negotiation, each gated on client capabilities
- Client MCP servers forwarded into Pi via a bundled extension using Pi's native registration API
- Extension UI (input/editor dialogs) surfaced as ACP elicitation; extension commands complete cleanly
- Slash commands: file-based prompts from `~/.pi/agent/prompts/` and `<project>/.pi/prompts/`, built-ins like `/compact`, `/export`, `/session`, `/name`, `/steering`, `/follow-up`, and `/skill:*` when enabled in Pi settings

### Provider and auth posture

Pi manages its own providers and credentials. `providers/list` returns an empty list, `authenticate` is a no-op (use `pi-acp --terminal-login` for interactive login), and `logout` is not advertised because the adapter cannot clear Pi credentials.

## Configuration

Environment variables (set them in your client's agent server `env`):

| Variable                         | Default  | Effect                                                       |
| -------------------------------- | -------- | ------------------------------------------------------------ |
| `PI_ACP_ENABLE_EMBEDDED_CONTEXT` | unset    | `true` advertises embedded-context prompt support            |
| `PI_ACP_KEEPALIVE_MS`            | `75000`  | No-op update cadence for quiet in-flight turns; `0` disables |
| `PI_ACP_RESPAWN_MAX_ATTEMPTS`    | `3`      | Per-session respawn budget for on-demand recovery            |
| `PI_ACP_RESPAWN_WINDOW_MS`       | `600000` | Rolling window for the respawn budget                        |
| `PI_ACP_PI_COMMAND`              | `pi`     | Override the `pi` executable path                            |

`additionalDirectories` on session requests is accepted but ignored with a stderr warning (Pi uses a single working directory per session).

See the [changelog](CHANGELOG.md) for release history.

## Development

```bash
npm install
npm run dev        # run from src via tsx
npm run build
npm run lint
npm run test
```

- `src/acp/*` — ACP server and translation layer
- `src/pi-rpc/*` — Pi subprocess wrapper (RPC protocol)
- `test/component/*`, `test/unit/*` — adapter behavior

## License

MIT (see [LICENSE](LICENSE)).
