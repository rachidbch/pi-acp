# JetBrains AIR extension contract — extraction for pi-acp

Status: research extraction (round 2, P1-5A). No product code. Primary source:
`agentclientprotocol/claude-agent-acp` v0.93.0 `src/air-extension.ts` and
`docs/air-extensions.md` (1640 lines — the authoritative contract). Codex-acp
2.2.2 ships an equivalent subset (`sessionIndex`, hooks trust, custom
instructions). Pin the exact 0.93.0 schema when implementing; tolerate unknown
fields in both directions.

## Negotiation

- Client declares in `initialize`:
  `clientCapabilities._meta.jetbrains.air = { version: 1, capabilities: [...] }`.
- A capability is active only when `version` is a finite integer >= 1,
  `capabilities` is an array, and it contains the exact name. A malformed
  declaration enables nothing (fail-closed).
- Agent answers in the `initialize` response `_meta.jetbrains.air` with its own
  `{ version, capabilities }` plus nested blocks (`goal`, `steering`).
  Non-AIR clients get no `_meta.jetbrains` key at all.
- Every AIR payload rides under `_meta.jetbrains.air.<capability>` on the
  relevant message (tool calls, session updates, initialize).

## Capability inventory and pi-acp classification

| Capability                                       | AIR meaning (0.93.0)                                      | pi-acp classification                                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| `diffPatch`                                      | exact Git patch in the diff block of Edit/Write           | **Mappable**: pre-mutation snapshots already exist (`src/acp/session.ts` fileSnapshots, emits `ToolCallContent {type:'diff'}`); needs Git-patch formatting when the client declares it |
| `sessionFailure`                                 | warnings/errors as typed transcript records               | **Mappable**: notice/emit sites already exist (auto-retry, process-stopped, respawn-budget exhaustion); add the AIR typing behind the capability gate                                  |
| `customInstructions`                             | instructions from `session/new` `_meta`                   | **Mappable**: pi `--append-system-prompt` exists (MCP replace-mode already uses it; compose the two)                                                                                   |
| `recommendedValue`                               | concrete recommended model/effort rows                    | **Mappable**: configOptions already built from `getAvailableModels` + thinking levels; add recommendation markers                                                                      |
| `sessionIndex`                                   | paged/ordered `session/list` + row metadata               | **Mappable (larger)**: list + store exist; needs ordering/paging metadata; rename via pi `setSessionName` is easy; list subscription needs a change source (poll)                      |
| `sessionRename`                                  | `_session/rename` (with sessionIndex)                     | **Mappable**: `setSessionName` exists                                                                                                                                                  |
| `sessionArchive`                                 | `_session/archive`/`unarchive`                            | **Skip**: pi has no archive concept                                                                                                                                                    |
| `sessionListSubscribe`                           | `\_session/list/subscribe                                 | unsubscribe                                                                                                                                                                            | changes` | **Mappable (larger)**: needs polling or a pi-side change event |
| `sessionWorktrees`                               | rows flagged as linked worktrees                          | **Skip**: pi does not create worktrees                                                                                                                                                 |
| `agentFileChangeReport`                          | changed-file list on request via `session/prompt` `_meta` | **Mappable later**: edit/write tool events carry paths; needs request handling                                                                                                         |
| steering (`_meta.steering`, `_session/steering`) | mid-turn follow-up injection                              | **Mappable**: pi-acp already queues follow-up prompts; map steering onto the queue behind the capability gate                                                                          |
| goal (`_session/goal`)                           | set/clear a session goal                                  | **Skip**: no pi equivalent                                                                                                                                                             |
| `nativeSubagentSessions`                         | subagents as native ACP child sessions                    | **Skip**: no child-session RPC surface; emulating with extra pi processes breaks 1-session-1-process                                                                                   |
| `asyncTasks`                                     | background work as async tasks                            | **Skip**: pi background jobs not exposed over RPC                                                                                                                                      |
| `planFile`                                       | plan file path instead of plan text                       | **Skip**: pi has no plan mode                                                                                                                                                          |
| permission presentation                          | AIR-typed `session/request_permission` options            | **Skip (decision)**: approvals are owned locally by the pi autonomy extension; no ACP permission surface by design                                                                     |

## Phase B recommendation (smallest useful set, in order)

1. Negotiation plumbing only: detect AIR client, answer with an empty/gated
   capability list. Zero behavior change for non-AIR clients.
2. `diffPatch` (highest client value per line of code).
3. `sessionFailure` typing for existing notice sites.
4. `customInstructions` on `session/new`.
5. `recommendedValue` markers.
6. `sessionIndex` + `sessionRename` (needs list metadata design).

Explicit denylist (do not build): `nativeSubagentSessions`, `asyncTasks`,
`planFile`, `goal`, `sessionArchive`, `sessionWorktrees`, permission options.

## Corrections to earlier notes

- The namespace is `_meta.jetbrains.air` — **not** `_meta.ln.air` (the `ln`
  reading was a tooling artifact in round-2 notes; round-2 report updated).
