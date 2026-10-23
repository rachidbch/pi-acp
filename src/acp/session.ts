import type {
  ClientCapabilities,
  ContentBlock,
  McpServer,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind
} from '@agentclientprotocol/sdk/unstable'
import { RequestError } from '@agentclientprotocol/sdk/unstable'
import { randomUUID } from 'node:crypto'
import type { AcpClient } from './connection.js'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import {
  PiRpcProcess,
  PiRpcSpawnError,
  SESSION_STATS_TIMEOUT_MS,
  type PiPromptDisposition,
  type PiRpcEvent,
  type PiSessionStats
} from '../pi-rpc/process.js'
import { prepareMcpInjection, type McpInjectionPlan } from './mcp-descriptor.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import {
  bashCommand,
  bashExitCode,
  bashOutputDelta,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { toolResultToContent } from './translate/pi-tools.js'
import { handleExtensionUiRequest as translateExtensionUiRequest } from './extension-ui.js'
import { MessageIds, messageKey } from './translate/message-id.js'
import type { LaunchOptions } from './launch.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AcpClient
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
  clientCapabilities?: ClientCapabilities
  /** Launch flags, system prompt and headless mode from the request `_meta`. */
  launch?: LaunchOptions
}

export type StopReason = 'end_turn' | 'cancelled' | 'error' | 'max_tokens'

type PendingTurn = {
  outcome?: StopReason
  errorMessage?: string
  queued: QueuedTurn
  title?: string
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
  /** Whether pi's prompt RPC response (and its disposition) has arrived. */
  acknowledged: boolean
  /** Whether `agent_settled` has been emitted for this turn. */
  settled: boolean
  /** Context-token snapshot taken when the turn started (null on stats failure). */
  preStats: Promise<PiSessionStats | null>
  completing?: boolean
  summary: TurnSummary
}

type QueuedTurn = {
  message: string
  images: unknown[]
  title?: string
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
  /** Filled with derived per-turn usage (when computable) and the turn summary before the turn resolves. */
  usageOut?: { usage?: TurnUsage; summary?: TurnSummary }
}

/**
 * Map pi's `stats.contextUsage` to an ACP `usage_update`. Returns null whenever pi
 * reports no trustworthy token count (e.g. `tokens: null` right after compaction) or
 * the values are not usable integers.
 */
function toUsageUpdate(stats: PiSessionStats | null | undefined): SessionUpdate | null {
  const used = stats?.contextUsage?.tokens
  const size = stats?.contextUsage?.contextWindow

  if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0) return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return null

  return { sessionUpdate: 'usage_update', used, size }
}

export type TurnUsage = { totalTokens: number; inputTokens: number; outputTokens: number }

/**
 * `PromptResponse._meta.piAcp`: what happened in one ACP turn, summed from pi events.
 * `usage` adds up every assistant `message_end` usage of the turn (retries included).
 */
export type TurnSummary = {
  stopReason?: StopReason
  aborted: boolean
  errorMessage?: string
  retries: number
  compactions: number
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
}

function emptySummary(): TurnSummary {
  return {
    aborted: false,
    retries: 0,
    compactions: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  }
}

function addMessageUsage(summary: TurnSummary, usage: unknown): void {
  if (typeof usage !== 'object' || usage === null) return
  const u = usage as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  summary.usage.input += num(u.input)
  summary.usage.output += num(u.output)
  summary.usage.cacheRead += num(u.cacheRead)
  summary.usage.cacheWrite += num(u.cacheWrite)
  const cost = u.cost
  summary.usage.cost += num(typeof cost === 'object' && cost !== null ? (cost as Record<string, unknown>).total : cost)
}

function contextTokens(stats: PiSessionStats | null | undefined): number | null {
  const tokens = stats?.contextUsage?.tokens
  return typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : null
}

/**
 * Derive ACP `PromptResponse.usage` from pi context snapshots. pi only exposes
 * cumulative context tokens (`get_session_stats`), so this is context-growth
 * attribution, not billed API tokens: inputTokens = context at turn start
 * (prior turns included, no cache split), outputTokens = post - pre (assistant
 * output plus tool results), totalTokens = context after the turn. Real cost
 * flows separately via `usage_update.cost`. Returns null when either snapshot
 * is missing or the context shrank (e.g. compaction) - omit rather than
 * mislead.
 */
export function deriveTurnUsage(
  pre: PiSessionStats | null | undefined,
  post: PiSessionStats | null | undefined
): TurnUsage | null {
  const before = contextTokens(pre)
  const after = contextTokens(post)
  if (before === null || after === null || after < before) return null
  return { totalTokens: after, inputTokens: before, outputTokens: after - before }
}

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function getToolPath(args: unknown): string | undefined {
  const record = args as { path?: unknown; file_path?: unknown } | null | undefined
  if (typeof record?.path === 'string') return record.path
  if (typeof record?.file_path === 'string') return record.file_path
  return undefined
}

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
function getParsedEdits(args: unknown): Array<{ oldText: string; newText: string }> {
  const record = args as { oldText?: unknown; newText?: unknown; edits?: unknown } | null | undefined
  const parsed: Array<{ oldText: string; newText: string }> = []

  if (typeof record?.oldText === 'string' && typeof record?.newText === 'string') {
    parsed.push({ oldText: record.oldText, newText: record.newText })
  }

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit as { oldText?: unknown; newText?: unknown } | null | undefined
      if (typeof item?.oldText === 'string' && typeof item?.newText === 'string') {
        parsed.push({ oldText: item.oldText, newText: item.newText })
      }
    }
  }

  return parsed
}

function getEditOldTexts(args: unknown): string[] {
  const record = args as { oldText?: unknown; edits?: unknown } | null | undefined
  const oldTexts = getParsedEdits(args).map(edit => edit.oldText)

  if (typeof record?.oldText === 'string' && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText)

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = (edit as { oldText?: unknown } | null | undefined)?.oldText
      if (typeof oldText === 'string' && !oldTexts.includes(oldText)) oldTexts.push(oldText)
    }
  }

  return oldTexts
}

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path = getToolPath(args)
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

const KEEPALIVE_DEFAULT_INTERVAL_MS = 75_000

function keepaliveIntervalMs(): number {
  const raw = Number(process.env.PI_ACP_KEEPALIVE_MS)
  if (!Number.isFinite(raw) || raw < 0) return KEEPALIVE_DEFAULT_INTERVAL_MS
  return raw
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    const session = this.sessions.get(sessionId)
    if (session?.isDisposed()) {
      this.close(sessionId)
      return undefined
    }
    return session
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.dispose()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  /** Reclaim idle sessions without interrupting other threads' active turns. */
  closeIdleExcept(keepSessionId: string): void {
    for (const [id, session] of this.sessions) {
      if (id === keepSessionId) continue
      if (session.isTurnActive()) continue
      this.close(id)
    }
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    const mcpInjection = params.mcpServers.length ? prepareMcpInjection(params.mcpServers) : null
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand,
        ...(mcpInjection ? { mcpInjection } : {}),
        ...(params.launch?.args.length ? { launchArgs: params.launch.args } : {}),
        ...(params.launch?.systemPrompt ? { systemPrompt: params.launch.systemPrompt } : {})
      })
    } catch (e) {
      mcpInjection?.cleanup()
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch {
      state = null
    }

    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : crypto.randomUUID()
    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      autoTitle: true,
      mcpInjection,
      clientCapabilities: params.clientCapabilities,
      headless: params.launch?.headless === true
    })

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): PiAcpSession {
    const s = this.maybeGet(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(
    sessionId: string,
    params: SessionCreateParams & { proc: PiRpcProcess; mcpInjection?: McpInjectionPlan | null }
  ): PiAcpSession {
    const existing = this.maybeGet(sessionId)
    if (existing) return existing

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      autoTitle: false,
      mcpInjection: params.mcpInjection,
      clientCapabilities: params.clientCapabilities,
      headless: params.launch?.headless === true
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]
  readonly mcpInjection: McpInjectionPlan | null
  private readonly clientCapabilities: ClientCapabilities
  /** `_meta.piAcp.headless`: no banner or queue chatter; notices go out as `_meta`. */
  readonly headless: boolean

  private startupInfo: string | null = null
  private startupInfoSent = false
  private initialTitlePending: boolean
  private lastPublishedTitle: string | null | undefined
  private titleUpdateQueue: Promise<void> = Promise.resolve()

  readonly proc: PiRpcProcess
  private readonly conn: AcpClient
  private readonly fileCommands: FileSlashCommand[]

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private readonly turnQueue: QueuedTurn[] = []
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()
  private readonly terminalToolCalls = new Set<string>()
  private interactions = new AbortController()
  private readonly messageIds = new MessageIds()
  private activeMessageId: string | undefined
  private activeMessageKey: string | undefined
  private activeCompactionId: string | undefined
  private compactionVersion = 0
  private manualCompaction = false
  private compactionCancelled = false

  // pi can emit multiple `turn_end` and `agent_end` events for a single user prompt
  // when retry, compaction, or queued continuations run. The session-level prompt
  // completes only when `agent_settled` is emitted.
  private inAgentLoop = false

  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>()
  private fileMutationToolCallIds = new Set<string>()
  private bashToolCallIds = new Set<string>()
  private bashOutputSnapshots = new Map<string, string>()

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()
  private disposed = false
  private disposalReason: StopReason | undefined
  private unsubscribe: (() => void) | undefined
  private keepaliveTimer: NodeJS.Timeout | null = null
  private lastUpdateSentAt = Date.now()

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AcpClient
    fileCommands?: FileSlashCommand[]
    autoTitle?: boolean
    mcpInjection?: McpInjectionPlan | null
    clientCapabilities?: ClientCapabilities
    headless?: boolean
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.mcpInjection = opts.mcpInjection ?? null
    this.clientCapabilities = opts.clientCapabilities ?? {}
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []
    this.initialTitlePending = opts.autoTitle ?? false
    this.headless = opts.headless === true

    this.unsubscribe = this.proc.onEvent(ev => {
      if (!this.disposed) this.handlePiEvent(ev)
    })
  }

  isTurnActive(): boolean {
    return !this.disposed && (this.isExecutionBusy() || this.turnQueue.length > 0)
  }

  private isExecutionBusy(): boolean {
    return (
      this.pendingTurn !== null || this.inAgentLoop || this.activeCompactionId !== undefined || this.manualCompaction
    )
  }

  isDisposed(): boolean {
    return this.disposed
  }

  seedMessageIds(messages: unknown[]): void {
    this.messageIds.seed(messages)
  }

  messageIdForReplay(message: unknown): string {
    return this.messageIds.next(message)
  }

  async compact(
    customInstructions?: string,
    signal?: AbortSignal
  ): Promise<{ cancelled: true } | { cancelled: false; result: unknown }> {
    if (signal?.aborted) return { cancelled: true }
    if (this.disposed) throw RequestError.invalidParams('Session is closed')
    if (this.isTurnActive()) throw RequestError.invalidParams('Cannot compact while a prompt is active')
    const abort = () => {
      void this.proc.abort().catch(() => {})
    }
    signal?.addEventListener('abort', abort, { once: true })
    this.manualCompaction = true
    this.cancelRequested = false
    const version = this.compactionVersion
    this.handlePiEvent({ type: 'compaction_start', reason: 'manual' })
    this.ensureKeepalive()
    try {
      const result = await this.proc.compact(customInstructions)
      if (this.compactionVersion === version)
        this.handlePiEvent({ type: 'compaction_end', reason: 'manual', result, aborted: signal?.aborted === true })
      await this.flushEmits()
      return signal?.aborted || this.cancelRequested || this.disposalReason === 'cancelled' || this.compactionCancelled
        ? { cancelled: true }
        : { cancelled: false, result }
    } catch (error) {
      if (this.compactionVersion === version) {
        this.handlePiEvent({
          type: 'compaction_end',
          reason: 'manual',
          aborted: signal?.aborted === true || this.cancelRequested || this.disposalReason === 'cancelled',
          errorMessage: error instanceof Error ? error.message : String(error)
        })
      }
      await this.flushEmits()
      if (signal?.aborted || this.cancelRequested || this.disposalReason === 'cancelled' || this.compactionCancelled)
        return { cancelled: true }
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
      this.manualCompaction = false
      this.startNextTurn()
    }
  }

  dispose(reason: StopReason = 'cancelled'): void {
    if (this.disposed) return
    if (this.activeCompactionId && this.clientCapabilities.session?.compaction != null) {
      this.emit({
        sessionUpdate: 'compaction_update',
        compactionId: this.activeCompactionId,
        status: reason === 'cancelled' ? 'cancelled' : 'failed'
      })
      this.activeCompactionId = undefined
    }
    this.finishOutstandingTools(reason === 'cancelled' ? 'Session closed.' : 'Pi process stopped.')
    this.disposed = true
    this.disposalReason = reason
    this.stopKeepalive()
    this.interactions.abort()
    this.unsubscribe?.()
    const turn = this.pendingTurn
    this.pendingTurn = null
    const queued = this.turnQueue.splice(0)
    void this.flushEmits().then(() => {
      turn?.resolve(reason)
      for (const item of queued) item.resolve(reason)
    })
    this.proc.dispose()
  }

  setStartupInfo(text: string) {
    if (this.headless) return
    this.startupInfo = text
    this.startupInfoSent = false
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return
    this.startupInfoSent = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  async prompt(
    message: string,
    images: unknown[] = [],
    title?: string,
    signal?: AbortSignal,
    usageOut?: { usage?: TurnUsage; summary?: TurnSummary }
  ): Promise<StopReason> {
    if (this.disposed || signal?.aborted) return 'cancelled'
    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    let queued!: QueuedTurn
    const abort = () => {
      if (this.pendingTurn?.queued === queued) {
        this.cancelRequested = true
        this.interactions.abort()
        this.finishOutstandingTools('Cancelled.')
        void this.proc.abort().catch(() => {})
      } else {
        const index = this.turnQueue.indexOf(queued)
        if (index < 0) return
        this.turnQueue.splice(index, 1)
        queued.resolve('cancelled')
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: Boolean(this.pendingTurn) } }
        })
      }
    }
    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      queued = { message: expandedMessage, images, title, resolve, reject, usageOut }
      signal?.addEventListener('abort', abort, { once: true })

      // If a turn is already running, enqueue.
      if (this.isExecutionBusy()) {
        this.turnQueue.push(queued)
        this.ensureKeepalive()

        // Best-effort: notify client that a prompt was queued.
        // This doesn't work in Zed yet, needs to be revisited
        if (!this.headless)
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `Queued message (position ${this.turnQueue.length}).`
            }
          })

        // Also publish queue depth via session info metadata.
        // This also not visible in the client
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        })

        return
      }

      // No turn is running; start immediately.
      this.startTurn(queued)
    })

    try {
      return await turnPromise
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true
    this.interactions.abort()
    this.finishOutstandingTools('Cancelled.')

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve('cancelled')

      if (!this.headless)
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Cleared queued prompts.' }
        })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  async setSessionName(name: string): Promise<void> {
    return this.enqueueTitleUpdate(async () => {
      await this.proc.setSessionName(name)
      this.publishTitle(name)
    })
  }

  private enqueueTitleUpdate(update: () => Promise<void>): Promise<void> {
    const result = this.titleUpdateQueue.then(update)
    this.titleUpdateQueue = result.catch(() => {})
    return result
  }

  publishTitle(title: string | null, updatedAt: string | null = new Date().toISOString()): Promise<void> {
    if (this.lastPublishedTitle === title) return this.lastEmit
    this.lastPublishedTitle = title
    this.emit({
      sessionUpdate: 'session_info_update',
      title,
      ...(updatedAt ? { updatedAt } : {})
    })
    return this.lastEmit
  }

  private async maybeAutoTitle(title?: string): Promise<void> {
    if (!this.initialTitlePending || !title) return
    this.initialTitlePending = false

    try {
      await this.enqueueTitleUpdate(async () => {
        const state = (await this.proc.getState()) as { sessionName?: unknown } | null
        const currentTitle = typeof state?.sessionName === 'string' ? state.sessionName.trim() : ''
        if (currentTitle) {
          this.publishTitle(currentTitle)
          return
        }
        if (this.lastPublishedTitle) return

        await this.proc.setSessionName(title)
        this.publishTitle(title)
      })
    } catch {
      // Auto-titling is best-effort and must not fail the completed prompt.
    }
  }

  private emit(update: SessionUpdate): void {
    if (this.disposed) return
    this.lastUpdateSentAt = Date.now()
    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update
        })
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      })
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  /**
   * Best-effort: publish the real pi context-window occupancy as ACP `usage_update`.
   * Queued updates are flushed even when the stats query fails or times out, so callers
   * can await this before resolving `session/prompt`.
   */
  async publishContextUsage(): Promise<PiSessionStats | null> {
    let stats: PiSessionStats | null = null
    try {
      // Older/stubbed pi processes may not expose the stats RPC at all.
      if (typeof this.proc.getSessionStats === 'function') {
        stats = await this.proc.getSessionStats(SESSION_STATS_TIMEOUT_MS)
        const update = toUsageUpdate(stats)
        if (update) this.emit(update)
      }
    } catch {
      // Context usage is auxiliary; never fail or delay the turn because of it.
    }

    await this.flushEmits()
    return stats
  }

  private async settleTurn(): Promise<void> {
    this.inAgentLoop = false
    const turn = this.pendingTurn
    if (turn) {
      turn.settled = true
      if (turn.acknowledged) await this.completeTurn(turn)
    } else {
      await this.publishContextUsage()
      this.startNextTurn()
    }
  }

  private async completeTurn(turn: PendingTurn): Promise<void> {
    if (this.pendingTurn !== turn || turn.completing || !turn.acknowledged) return
    turn.completing = true
    this.finishOutstandingTools(this.cancelRequested ? 'Cancelled.' : 'Turn ended before the tool completed.')
    // Ensure all updates derived from pi events (plus the final usage update) are
    // delivered before we resolve the ACP `session/prompt` request.
    const postStats = await this.publishContextUsage()
    if (this.pendingTurn !== turn) return
    this.pendingTurn = null
    if (turn.queued.usageOut) {
      const stopReason: StopReason =
        this.cancelRequested || turn.outcome === 'cancelled' ? 'cancelled' : (turn.outcome ?? 'end_turn')
      turn.queued.usageOut.summary = { ...turn.summary, stopReason }
    }
    if (this.cancelRequested || turn.outcome === 'cancelled') turn.resolve('cancelled')
    else if (turn.outcome === 'error') {
      const error = new Error(turn.errorMessage || 'Pi provider failed')
      turn.reject(
        maybeAuthRequiredError(error, this.clientCapabilities) ??
          RequestError.internalError({ reason: 'pi_error' }, error.message)
      )
    } else {
      // The turn-start snapshot runs concurrently with the turn; race it with the same
      // auxiliary budget so a hanging stats call can never block prompt resolution.
      const preStats = await Promise.race([
        turn.preStats,
        new Promise<null>(resolve => {
          const timer = setTimeout(resolve, SESSION_STATS_TIMEOUT_MS, null)
          timer.unref?.()
        })
      ])
      const usage = deriveTurnUsage(preStats, postStats)
      if (usage && turn.queued.usageOut) turn.queued.usageOut.usage = usage
      turn.resolve(turn.outcome ?? 'end_turn')
    }
    this.startNextTurn()
  }

  private startNextTurn(): void {
    if (this.disposed) return
    if (this.isExecutionBusy()) return
    const next = this.turnQueue.shift()
    if (next) {
      if (!this.headless)
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
        })
      this.startTurn(next)
    } else {
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: false } }
      })
    }
  }

  private emitBashToolCall(params: {
    sessionUpdate: 'tool_call' | 'tool_call_update'
    toolCallId: string
    toolName: string
    args: unknown
    status: 'pending' | 'in_progress'
    locations?: ToolCallLocation[]
    includeTerminal: boolean
  }): void {
    this.bashToolCallIds.add(params.toolCallId)
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title: bashCommand(params.args) ?? params.toolName,
      name: params.toolName,
      kind: 'execute',
      status: params.status,
      locations: params.locations,
      ...(params.includeTerminal ? { content: bashTerminalContent(params.toolCallId) } : {}),
      ...(params.includeTerminal ? { _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd) } : {})
    })
  }

  richToolContent(result: unknown): ReturnType<typeof toolResultToContent> {
    return toolResultToContent(result)
  }

  private emitBashOutputUpdate(params: {
    toolCallId: string
    status: 'in_progress' | 'completed' | 'failed'
    result: unknown
    isError?: boolean
  }): void {
    const text = bashResultText(params.result)
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? ''
    const delta = bashOutputDelta(previous, text)
    this.bashOutputSnapshots.set(params.toolCallId, text)

    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: params.status,
      ...(params.status !== 'in_progress' ? { rawOutput: params.result } : {}),
      _meta: {
        ...(delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {}),
        ...(params.status === 'completed' || params.status === 'failed'
          ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError)))
          : {})
      }
    })
  }

  private cleanupToolCall(toolCallId: string): void {
    this.terminalToolCalls.add(toolCallId)
    this.currentToolCalls.delete(toolCallId)
    this.fileSnapshots.delete(toolCallId)
    this.fileMutationToolCallIds.delete(toolCallId)
    this.bashToolCallIds.delete(toolCallId)
    this.bashOutputSnapshots.delete(toolCallId)
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.inAgentLoop = false
    this.activeMessageId = undefined
    this.activeMessageKey = undefined
    if (this.interactions.signal.aborted) this.interactions = new AbortController()
    this.ensureKeepalive()

    const turn: PendingTurn = {
      queued: t,
      acknowledged: false,
      settled: false,
      title: t.title,
      resolve: t.resolve,
      reject: t.reject,
      preStats: Promise.resolve(null),
      summary: emptySummary()
    }
    this.pendingTurn = turn
    // Snapshot context tokens at turn start so per-turn usage can be derived at completion.
    turn.preStats =
      typeof this.proc.getSessionStats === 'function'
        ? this.proc.getSessionStats(SESSION_STATS_TIMEOUT_MS).catch(() => null)
        : Promise.resolve(null)
    void this.maybeAutoTitle(t.title)

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    // A `handled` disposition means pi answered the prompt without starting an agent
    // loop (e.g. an extension command); such turns complete on the RPC response instead
    // of waiting for `agent_settled`, which would never arrive.
    const acceptDisposition = (disposition: PiPromptDisposition | undefined) => {
      if (this.pendingTurn !== turn || turn.acknowledged) return
      turn.acknowledged = true
      if (disposition === 'started' || disposition === 'queued') turn.settled = false
      if (disposition === 'handled' || turn.settled) void this.completeTurn(turn)
    }

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // The prompt RPC only acknowledges acceptance; retry, compaction, or queued
    // continuations may emit multiple `agent_end` events before `agent_settled`.
    this.proc
      .prompt(t.message, t.images, undefined, acceptDisposition)
      .then(acceptDisposition)
      .catch(async err => {
        // If the subprocess errors before we get `agent_settled`, treat as error unless cancelled.
        // Also ensure we flush any already-enqueued updates first.
        if (this.pendingTurn !== turn) return
        this.finishOutstandingTools(this.cancelRequested ? 'Cancelled.' : 'Pi prompt failed.')
        await this.flushEmits()
        // If this looks like an auth/config issue, surface AUTH_REQUIRED so clients can offer terminal login.
        if (this.pendingTurn !== turn) return
        const authErr = maybeAuthRequiredError(err, this.clientCapabilities)
        this.pendingTurn = null
        if (this.cancelRequested) turn.resolve('cancelled')
        else if (authErr) turn.reject(authErr)
        else turn.resolve(this.cancelRequested ? 'cancelled' : 'error')
        for (const queued of this.turnQueue.splice(0)) queued.resolve('error')

        // If the prompt failed, do not automatically proceed—pi may be unhealthy.
        // But we still clear the queueDepth metadata.
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } }
        })
        void err
      })
  }

  private ensureKeepalive(): void {
    if (this.keepaliveTimer || this.disposed) return
    const interval = keepaliveIntervalMs()
    if (interval <= 0) return
    this.keepaliveTimer = setInterval(
      () => {
        if (!this.isTurnActive()) {
          this.stopKeepalive()
          return
        }
        if (Date.now() - this.lastUpdateSentAt >= interval) {
          this.emit({
            sessionUpdate: 'session_info_update',
            _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true, keepalive: true } }
          })
        }
      },
      Math.max(250, Math.round(interval / 3))
    )
    this.keepaliveTimer.unref?.()
  }

  private stopKeepalive(): void {
    if (!this.keepaliveTimer) return
    clearInterval(this.keepaliveTimer)
    this.keepaliveTimer = null
  }

  private finishOutstandingTools(message: string): void {
    for (const toolCallId of this.currentToolCalls.keys()) {
      this.emit({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: message } }],
        ...(this.bashToolCallIds.has(toolCallId) ? { _meta: bashTerminalExitMeta(toolCallId, 1) } : {})
      })
      this.cleanupToolCall(toolCallId)
    }
  }

  private emitNotice(title: string, severity: 'info' | 'warning' | 'error' = 'info'): void {
    if (this.clientCapabilities.session?.notices != null) {
      this.emit({ sessionUpdate: 'notice', title, severity })
    } else if (this.headless) {
      // Keep the message stream to model output only.
      this.emit({ sessionUpdate: 'session_info_update', _meta: { piAcp: { notice: { title, severity } } } })
    } else {
      this.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: title } })
    }
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')
    const toolCallId = typeof ev.toolCallId === 'string' ? ev.toolCallId : undefined
    if (type.startsWith('tool_execution_') && toolCallId && this.terminalToolCalls.has(toolCallId)) return

    switch (type) {
      case 'message_start': {
        const key = messageKey(ev.message)
        const messageId = this.messageIds.next(ev.message)
        if (key?.startsWith('assistant:')) {
          this.activeMessageKey = key
          this.activeMessageId = messageId
        }
        break
      }

      case 'message_end': {
        const message =
          typeof ev.message === 'object' && ev.message !== null ? (ev.message as Record<string, unknown>) : undefined
        if (message?.role === 'assistant' && this.pendingTurn) {
          addMessageUsage(this.pendingTurn.summary, message.usage)
          if (message.stopReason === 'error' && typeof message.errorMessage === 'string')
            this.pendingTurn.summary.errorMessage = message.errorMessage
          this.pendingTurn.outcome =
            message.stopReason === 'error'
              ? 'error'
              : message.stopReason === 'aborted'
                ? 'cancelled'
                : message.stopReason === 'length'
                  ? 'max_tokens'
                  : 'end_turn'
          this.pendingTurn.errorMessage =
            message.stopReason === 'error' && typeof message.errorMessage === 'string'
              ? message.errorMessage
              : undefined
        }
        if (messageKey(ev.message)?.startsWith('assistant:')) {
          this.activeMessageId = undefined
          this.activeMessageKey = undefined
        }
        break
      }

      case 'pi_acp_process_error': {
        this.emitNotice(typeof ev.message === 'string' ? ev.message : 'Pi process stopped.', 'error')
        this.finishOutstandingTools('Pi process stopped.')
        this.dispose('error')
        break
      }
      case 'session_info_changed': {
        const name = (ev as { name?: unknown }).name
        if (typeof name === 'string' || name === undefined) this.publishTitle(name ?? null)
        break
      }

      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent
        const key = messageKey(ev.message)
        if (!this.activeMessageId || (key && key !== this.activeMessageKey)) {
          this.activeMessageId = this.messageIds.next(ev.message)
          this.activeMessageKey = key
        }

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            messageId: this.activeMessageId,
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            messageId: `${this.activeMessageId}:thought`,
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
        // while the model is still streaming tool call args.
        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          const toolCall =
            // pi sometimes includes the tool call directly on the event
            (ame as any)?.toolCall ??
            // ...and always includes it in the partial assistant message at contentIndex
            (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0]

          const toolCallId = String((toolCall as any)?.id ?? '')
          const toolName = String((toolCall as any)?.name ?? 'tool')

          if (toolCallId) {
            if (this.terminalToolCalls.has(toolCallId)) break
            const rawInput =
              (toolCall as any)?.arguments && typeof (toolCall as any).arguments === 'object'
                ? (toolCall as any).arguments
                : (() => {
                    const s = String((toolCall as any)?.partialArgs ?? '')
                    if (!s) return undefined
                    try {
                      return JSON.parse(s)
                    } catch {
                      return { partialArgs: s }
                    }
                  })()

            const locations = toToolCallLocations(rawInput, this.cwd)
            const existingStatus = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? 'pending'

            if (isBashTool(toolName)) {
              if (!existingStatus) this.currentToolCalls.set(toolCallId, 'pending')
              this.emitBashToolCall({
                sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
                toolCallId,
                toolName,
                args: rawInput,
                status,
                locations,
                includeTerminal: !existingStatus
              })
            } else if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, 'pending')
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId,
                title: toolName,
                name: toolName,
                kind: toToolKind(toolName),
                status,
                locations,
                rawInput
              })
            } else {
              // Best-effort: keep rawInput updated while args are streaming.
              // Keep the existing status (pending or in_progress).
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status,
                locations,
                rawInput
              })
            }
          }

          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'tool_execution_start': {
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        let line: number | undefined

        if (isBashTool(toolName)) {
          const locations = toToolCallLocations(args, this.cwd)
          const existingStatus = this.currentToolCalls.get(toolCallId)
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
            toolCallId,
            toolName,
            args,
            status: 'in_progress',
            locations,
            includeTerminal: !existingStatus
          })
          break
        }

        // Capture pre-mutation file contents so we can emit a structured ACP diff.
        const isFileMutation = toolName === 'edit' || toolName === 'write'
        let snapshotOldText: string | null | undefined
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId)
          const p = getToolPath(args)
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              snapshotOldText = readFileSync(abs, 'utf8')
              this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText })

              if (toolName === 'edit') {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle)
                  if (typeof line === 'number') break
                }
              }
            } catch {
              snapshotOldText = null
              this.fileSnapshots.set(toolCallId, { path: p, oldText: null })
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
            name: toolName,
            kind: toToolKind(toolName),
            status: 'in_progress',
            locations,
            rawInput: args
          })
        } else {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
            locations,
            rawInput: args
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({ toolCallId, status: 'in_progress', result: partial })
          break
        }

        const content = this.fileMutationToolCallIds.has(toolCallId) ? [] : this.richToolContent(partial)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: content.length ? content : undefined,
          ...(this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: partial })
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? 'failed' : 'completed',
            result,
            isError
          })
          this.cleanupToolCall(toolCallId)
          break
        }

        const snapshot = this.fileSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined
        let hasStructuredDiff = false

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                }
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        if (!content && !hasStructuredDiff) {
          const resultContent = this.richToolContent(result)
          if (resultContent.length) content = resultContent
        }

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          ...(hasStructuredDiff ? {} : { rawOutput: result })
        })

        this.cleanupToolCall(toolCallId)
        break
      }

      case 'extension_ui_request': {
        void translateExtensionUiRequest(ev, {
          sessionId: this.sessionId,
          conn: this.conn,
          clientCapabilities: this.clientCapabilities,
          signal: this.interactions.signal,
          sendResponse: response => this.proc.sendExtensionUiResponse(response),
          emit: update => this.emit(update)
        }).catch(() => {})
        break
      }

      case 'auto_retry_start': {
        if (this.pendingTurn) this.pendingTurn.summary.retries++
        this.emitNotice(formatAutoRetryMessage(ev))
        break
      }

      case 'auto_retry_end': {
        this.emitNotice('Retry finished, resuming.')
        break
      }

      case 'compaction_start':
      case 'auto_compaction_start': {
        if (this.activeCompactionId) break
        this.compactionCancelled = false
        this.activeCompactionId = randomUUID()
        if (this.clientCapabilities.session?.compaction != null) {
          this.emit({
            sessionUpdate: 'compaction_update',
            compactionId: this.activeCompactionId,
            status: 'in_progress'
          })
          break
        }
        this.emitNotice(
          ev.reason === 'manual' ? 'Compacting context...' : 'Context nearing limit, running automatic compaction...'
        )
        break
      }

      case 'compaction_end':
      case 'auto_compaction_end': {
        if (this.pendingTurn && ev.aborted !== true) this.pendingTurn.summary.compactions++
        this.compactionVersion++
        this.compactionCancelled = ev.aborted === true
        if (this.clientCapabilities.session?.compaction != null) {
          const result =
            typeof ev.result === 'object' && ev.result !== null ? (ev.result as Record<string, unknown>) : undefined
          const error = typeof ev.errorMessage === 'string' && ev.errorMessage ? ev.errorMessage : undefined
          const summary = typeof result?.summary === 'string' ? result.summary : undefined
          this.emit({
            sessionUpdate: 'compaction_update',
            compactionId: this.activeCompactionId ?? randomUUID(),
            status: ev.aborted === true ? 'cancelled' : error ? 'failed' : 'completed',
            ...(summary !== undefined ? { summary: [{ type: 'text', text: summary }] } : {}),
            ...(error && ev.aborted !== true ? { error } : {})
          })
          this.activeCompactionId = undefined
          break
        }
        this.activeCompactionId = undefined
        if (ev.aborted === true) this.emitNotice('Compaction cancelled.')
        else if (typeof ev.errorMessage === 'string' && ev.errorMessage)
          this.emitNotice(`Compaction failed: ${ev.errorMessage}`, 'error')
        else this.emitNotice('Automatic compaction finished; context was summarized to continue the session.')
        break
      }

      case 'agent_start': {
        this.inAgentLoop = true
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_settled`.
        break
      }

      case 'agent_end': {
        // One low-level run ended. Pi may still retry, compact, or process a queued
        // continuation, so keep the ACP turn open until `agent_settled`.
        this.inAgentLoop = false
        break
      }

      case 'agent_settled': {
        if (this.pendingTurn && ev.aborted === true) this.pendingTurn.summary.aborted = true
        void this.settleTurn()
        break
      }

      default:
        break
    }
  }
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}

export function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return 'execute'
    case 'grep':
    case 'find':
    case 'ls':
    case 'rg':
      return 'search'
    case 'trash':
    case 'rm':
      return 'delete'
    case 'mv':
    case 'move':
    case 'rename':
      return 'move'
    case 'fetch':
    case 'web_fetch':
      return 'fetch'
    case 'todo':
      return 'think'
    default:
      return 'other'
  }
}
