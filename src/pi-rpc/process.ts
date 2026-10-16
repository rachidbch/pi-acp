import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import crossSpawn from 'cross-spawn'
import { z } from 'zod'
import { getPiCommand, shouldUseShellForPiCommand } from './command.js'
import { PI_ACP_MCP_DESCRIPTOR_ENV, type McpInjectionPlan } from '../acp/mcp-descriptor.js'
import { fileURLToPath } from 'node:url'

export class PiRpcSpawnError extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code?: string

  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message)
    this.name = 'PiRpcSpawnError'
    this.code = opts?.code
    ;(this as any).cause = opts?.cause
  }
}

const ESC = String.fromCharCode(0x1b)
const CSI = String.fromCharCode(0x9b)

const ANSI_ESCAPE_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  'g'
)

function stripAnsi(s: string): string {
  // Basic ANSI escape stripping (colors, cursor movement, etc.)
  return s.replace(ANSI_ESCAPE_REGEX, '')
}

type PiRpcCommand =
  | { type: 'prompt'; id?: string; message: string; images?: unknown[] }
  | { type: 'abort'; id?: string }
  | { type: 'get_state'; id?: string }
  // Model
  | { type: 'get_available_models'; id?: string }
  | { type: 'set_model'; id?: string; provider: string; modelId: string }
  // Thinking
  | { type: 'get_available_thinking_levels'; id?: string }
  | { type: 'set_thinking_level'; id?: string; level: string }
  // Modes
  | { type: 'set_follow_up_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  | { type: 'set_steering_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  // Compaction
  | { type: 'compact'; id?: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id?: string; enabled: boolean }
  // Session
  | { type: 'get_session_stats'; id?: string }
  | { type: 'set_session_name'; id?: string; name: string }
  | { type: 'export_html'; id?: string; outputPath?: string }
  | { type: 'switch_session'; id?: string; sessionPath: string }
  // Messages
  | { type: 'get_messages'; id?: string }
  // Commands
  | { type: 'get_commands'; id?: string }

type PiRpcResponse = {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

type PiExtensionUiResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true }

export type PiRpcEvent = Record<string, unknown>

const rpcEventSchema = z.object({ type: z.string().min(1) }).passthrough()
const rpcResponseSchema = z.object({
  type: z.literal('response'),
  id: z.string().optional(),
  command: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional()
})

const STARTUP_EVENT_MAX_COUNT = 1024
const STARTUP_EVENT_MAX_BYTES = 4 * 1024 * 1024

/** Maximum wait for an auxiliary context-usage update. */
export const SESSION_STATS_TIMEOUT_MS = 1_000

/**
 * Shape of `stats.contextUsage` in pi's `get_session_stats` response.
 * `tokens` is null while pi has no trustworthy token count (e.g. right after compaction).
 */
export type PiContextUsage = {
  tokens?: number | null
  contextWindow?: number | null
}

export type PiSessionStats = {
  sessionId?: string
  sessionFile?: string
  totalMessages?: number
  cost?: number
  tokens?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }
  contextUsage?: PiContextUsage | null
}

type SpawnParams = {
  cwd: string
  /** Optional override for `pi` executable name/path */
  piCommand?: string
  /** If set, pi will persist the session to this exact file (via `--session <path>`). */
  sessionPath?: string
  /** Client-provided MCP servers to inject into pi (see acp/mcp-descriptor.ts). */
  mcpInjection?: McpInjectionPlan
}

const MIN_PI_VERSION_FOR_MCP_INJECTION = '1.0.0'
const PI_VERSION_TIMEOUT_MS = 2_000
const PI_VERSION_MAX_OUTPUT_BYTES = 64 * 1024

function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(part => Number.parseInt(part, 10) || 0)
  const pb = b.split('.').map(part => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

function resolveBootstrapPath(name: 'mcp-bootstrap.js'): string | null {
  // src layout (tsx dev): ../pi-extension relative to src/pi-rpc; bundle layout: ./pi-extension next to dist/index.js.
  const candidates = [
    fileURLToPath(new URL(`./pi-extension/${name}`, import.meta.url)),
    fileURLToPath(new URL(`../pi-extension/${name}`, import.meta.url))
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const liveVersionProbes = new Set<() => void>()
process.once('exit', () => {
  for (const cleanup of liveVersionProbes) cleanup()
})

function killVersionProbeTree(child: ChildProcess): void {
  const killChild = () => {
    try {
      child.kill('SIGKILL')
    } catch {
      // The probe may already have exited.
    }
  }
  if (!child.pid) {
    killChild()
    return
  }
  if (process.platform === 'win32') {
    try {
      const killer = crossSpawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: PI_VERSION_TIMEOUT_MS,
        killSignal: 'SIGKILL'
      })
      killer.on('error', killChild)
      killer.on('exit', code => {
        if (code !== 0) killChild()
      })
    } catch {
      killChild()
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    killChild()
  }
}

function probePiVersion(cmd: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(cmd, ['--version'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })
    const cleanup = () => killVersionProbeTree(child)
    liveVersionProbes.add(cleanup)
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let settled = false
    const timer = setTimeout(() => fail(new Error('version probe timed out')), PI_VERSION_TIMEOUT_MS)

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      child.stdout?.destroy()
      child.stderr?.destroy()
      reject(error)
    }
    const capture = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      if (settled) return
      outputBytes += chunk.length
      if (outputBytes > PI_VERSION_MAX_OUTPUT_BYTES) {
        fail(new Error('version probe output exceeded limit'))
        return
      }
      if (stream === 'stdout') stdout += chunk.toString()
      else stderr += chunk.toString()
    }
    child.stdout?.on('data', (chunk: Buffer) => capture(chunk, 'stdout'))
    child.stderr?.on('data', (chunk: Buffer) => capture(chunk, 'stderr'))
    child.on('error', () => fail(new Error('version probe could not start')))
    child.on('close', code => {
      liveVersionProbes.delete(cleanup)
      if (settled) return
      if (code !== 0) {
        fail(new Error('version probe exited unsuccessfully'))
        return
      }
      const raw = stdout.trim() || stderr.trim()
      const version = raw.replace(/^v/i, '').split(/[\s-]/)[0] ?? ''
      if (!/^\d+\.\d+\.\d+$/.test(version)) {
        fail(new Error('version probe returned an invalid version'))
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(version)
    })
  })
}

/** Refuse known old pi versions, but degrade gracefully when the version cannot be checked. */
async function canInjectMcpWithPi(cmd: string, cwd: string): Promise<boolean> {
  let version: string
  try {
    version = await probePiVersion(cmd, cwd)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'version probe failed'
    console.warn(`[pi-acp] MCP injection: ${reason}; skipping client MCP servers`)
    return false
  }
  if (compareVersion(version, MIN_PI_VERSION_FOR_MCP_INJECTION) < 0) {
    throw new PiRpcSpawnError(
      `pi v${version} does not support MCP injection: forwarding client MCP servers requires pi >= ${MIN_PI_VERSION_FOR_MCP_INJECTION}. Update pi (\`npm install -g @earendil-works/pi-coding-agent\`) or disable client MCP servers in your ACP client.`
    )
  }
  return true
}

export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, { resolve: (v: PiRpcResponse) => void; reject: (e: unknown) => void }>()
  private eventHandlers: Array<(ev: PiRpcEvent) => void> = []
  private readonly preludeLines: string[] = []
  private readonly mcpInjection: McpInjectionPlan | null
  private startupEvents: PiRpcEvent[] | null = []
  private startupEventBytes = 0
  private terminalError: Error | undefined

  private constructor(child: ChildProcessWithoutNullStreams, mcpInjection: McpInjectionPlan | null) {
    this.child = child
    this.mcpInjection = mcpInjection

    // Without a listener, an EPIPE on stdin (e.g. pi died mid-write) crashes the whole
    // adapter with an unhandled 'error' event. The write callback still reports the
    // error to the pending request. Optional call: minimal test fakes omit stdin.on.
    child.stdin.on?.('error', () => {})

    // RPC records are LF-delimited; U+2028/U+2029 inside JSON strings are content,
    // but node's readline splits on those too, silently corrupting otherwise valid
    // NDJSON. Split on \n explicitly (with utf8 decoding across chunk boundaries).
    const onLine = (line: string) => {
      if (!line.trim()) return
      if (this.terminalError) return
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        // pi may emit a human-readable prelude on stdout before NDJSON starts.
        // Capture it so the ACP adapter can surface it on session start.
        const cleaned = stripAnsi(String(line)).trimEnd()
        if (cleaned) this.preludeLines.push(cleaned)
        return
      }

      const event = rpcEventSchema.safeParse(msg)
      if (!event.success) return
      if (event.data.type === 'response') {
        const id = typeof event.data.id === 'string' ? event.data.id : undefined
        // Responses for unknown or already timed-out ids are never session events.
        if (id !== undefined) {
          const response = rpcResponseSchema.safeParse(msg)
          if (response.success) this.pending.get(id)?.resolve(response.data)
          else this.pending.get(id)?.reject(new Error('pi returned an invalid RPC response'))
        }
        return
      }

      if (this.startupEvents !== null) {
        this.startupEventBytes += Buffer.byteLength(line, 'utf8')
        if (this.startupEvents.length >= STARTUP_EVENT_MAX_COUNT || this.startupEventBytes > STARTUP_EVENT_MAX_BYTES) {
          this.fail(new Error('pi startup event buffer exceeded limit (1024 events / 4 MiB); refusing to drop events'))
          this.dispose('SIGKILL')
          return
        }
        this.startupEvents.push(event.data)
        return
      }

      for (const h of this.eventHandlers) h(event.data)
    }

    let stdoutRest = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutRest += chunk
      let newline: number
      while ((newline = stdoutRest.indexOf('\n')) !== -1) {
        const line = stdoutRest.slice(0, newline).replace(/\r$/, '')
        stdoutRest = stdoutRest.slice(newline + 1)
        onLine(line)
      }
    })

    child.on('exit', (code, signal) => {
      this.mcpInjection?.cleanup()
      this.fail(new Error(`pi process exited (code=${code}, signal=${signal})`))
    })

    child.on('error', err => {
      this.mcpInjection?.cleanup()
      this.fail(err)
    })
  }

  static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
    // On Windows, npm commonly creates pi.cmd / pi.bat launcher scripts.
    const cmd = getPiCommand(params.piCommand)

    let mcpInjection = params.mcpInjection?.descriptorPath ? params.mcpInjection : null

    // The bundled extension registers client-provided MCP servers with pi's native MCP support.
    let mcpBootstrapPath: string | null = null
    if (mcpInjection) {
      try {
        if (await canInjectMcpWithPi(cmd, params.cwd)) {
          mcpBootstrapPath = resolveBootstrapPath('mcp-bootstrap.js')
          if (!mcpBootstrapPath) {
            console.warn(
              '[pi-acp] MCP injection: bundled pi extension not found next to the pi-acp install; skipping client MCP servers'
            )
          }
        }
      } catch (error) {
        mcpInjection.cleanup()
        throw error
      }
      if (!mcpBootstrapPath) {
        mcpInjection.cleanup()
        mcpInjection = null
      }
    }

    // Speed/robustness for ACP:
    // - themes are irrelevant in rpc mode and can be noisy/slow to load.
    // Keep extensions + prompt templates enabled because ACP users may rely on them
    // (e.g. MCP extensions, prompt templates for workflows).
    const args = ['--mode', 'rpc', '--no-themes']
    if (mcpBootstrapPath) args.push('-e', mcpBootstrapPath)
    if (params.sessionPath) args.push('--session', params.sessionPath)

    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    delete childEnv[PI_ACP_MCP_DESCRIPTOR_ENV]
    if (mcpInjection?.descriptorPath) childEnv[PI_ACP_MCP_DESCRIPTOR_ENV] = mcpInjection.descriptorPath

    // Windows cmd launchers need shell escaping; direct executables use native argv.
    const start = shouldUseShellForPiCommand(cmd) ? crossSpawn : spawn
    const child = start(cmd, args, {
      cwd: params.cwd,
      stdio: 'pipe',
      env: childEnv
    }) as ChildProcessWithoutNullStreams

    // Ensure spawn failures (e.g. ENOENT when pi isn't installed) are surfaced as a
    // deterministic error instead of later EPIPE/internal-error noise.
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (err: any) => {
          cleanup()
          reject(err)
        }
        const cleanup = () => {
          child.off('spawn', onSpawn)
          child.off('error', onError)
        }

        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    } catch (e: any) {
      mcpInjection?.cleanup()
      const code = typeof e?.code === 'string' ? e.code : undefined
      if (code === 'ENOENT') {
        throw new PiRpcSpawnError(
          `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
          { code, cause: e }
        )
      }

      if (code === 'EACCES') {
        throw new PiRpcSpawnError(`Could not start pi: permission denied (command: ${cmd}).`, { code, cause: e })
      }

      throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, { code, cause: e })
    }

    let stderrRest = ''
    child.stderr.on('data', (chunk: Buffer | string) => {
      // Forward pi stderr to the adapter's stderr: ACP clients capture agent stderr
      // (e.g. for their logs), and pi diagnostics (extension load failures, MCP errors)
      // only surface there.
      const text = stderrRest + chunk.toString()
      const lines = text.split('\n')
      stderrRest = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) process.stderr.write(`[pi] ${line}\n`)
      }
    })

    const proc = new PiRpcProcess(child, mcpInjection)

    // Best-effort handshake.
    // Important: pi may emit a get_state response pointing at a sessionFile in a directory
    // that is created lazily. Create the parent dir up-front to avoid later parse errors
    // when we call commands like export_html.
    try {
      const state = (await proc.getState(30_000)) as any
      const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
      if (sessionFile) {
        const { mkdirSync } = await import('node:fs')
        const { dirname } = await import('node:path')
        mkdirSync(dirname(sessionFile), { recursive: true })
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT') {
        proc.dispose()
        throw new PiRpcSpawnError(
          'Pi RPC did not become ready within 30 seconds. If a pi extension blocks startup, defer that work until a command or tool runs and try again.',
          { code: 'ETIMEDOUT', cause: error }
        )
      }
      // Unsupported or failed get_state remains best-effort, but terminal startup
      // failures (process died, startup buffer exceeded) are not.
    }
    if (proc.terminalError) throw proc.terminalError

    return proc
  }

  /**
   * The first subscriber synchronously receives the events emitted before it attached,
   * in wire order; later subscribers receive live events only. Until the first
   * subscription, exceeding 1024 buffered events or 4 MiB kills the process rather
   * than dropping events (a dropped permission request would deadlock the session).
   */
  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    if (this.terminalError) throw this.terminalError
    this.eventHandlers.push(handler)
    const startupEvents = this.startupEvents
    this.startupEvents = null
    this.startupEventBytes = 0
    if (startupEvents) {
      for (const event of startupEvents) handler(event)
    }
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler)
    }
  }

  dispose(signal: NodeJS.Signals | number = 'SIGTERM'): void {
    this.mcpInjection?.cleanup()
    this.fail(new Error('pi process disposed'))
    if (this.child.killed) return
    try {
      this.child.kill(signal as any)
    } catch {
      // ignore
    }
  }

  /**
   * Human-readable stdout lines emitted before RPC NDJSON begins (e.g. Context/Skills/Extensions info).
   * Themes are typically noisy/less useful for ACP, so callers can filter as needed.
   */
  consumePreludeLines(): string[] {
    const lines = this.preludeLines.splice(0, this.preludeLines.length)
    return lines
  }

  async prompt(message: string, images: unknown[] = []): Promise<void> {
    const res = await this.request({ type: 'prompt', message, images })
    if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async abort(): Promise<void> {
    const res = await this.request({ type: 'abort' })
    if (!res.success) throw new Error(`pi abort failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getState(timeoutMs?: number): Promise<unknown> {
    const res = await this.request({ type: 'get_state' }, { timeoutMs })
    if (!res.success) throw new Error(`pi get_state failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableModels(): Promise<unknown> {
    const res = await this.request({ type: 'get_available_models' })
    if (!res.success) throw new Error(`pi get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const res = await this.request({ type: 'set_model', provider, modelId })
    if (!res.success) throw new Error(`pi set_model failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    const res = await this.request({ type: 'get_available_thinking_levels' })
    if (!res.success)
      throw new Error(`pi get_available_thinking_levels failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data = res.data
    const levels = data && typeof data === 'object' && 'levels' in data ? data.levels : undefined
    if (
      !Array.isArray(levels) ||
      levels.length === 0 ||
      !levels.every(level => typeof level === 'string' && level.length > 0)
    ) {
      throw new Error('pi get_available_thinking_levels returned invalid levels')
    }
    return levels
  }

  async setThinkingLevel(level: string): Promise<void> {
    const res = await this.request({ type: 'set_thinking_level', level })
    if (!res.success) throw new Error(`pi set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_follow_up_mode', mode })
    if (!res.success) throw new Error(`pi set_follow_up_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_steering_mode', mode })
    if (!res.success) throw new Error(`pi set_steering_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async compact(customInstructions?: string): Promise<unknown> {
    const res = await this.request({ type: 'compact', customInstructions })
    if (!res.success) throw new Error(`pi compact failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    const res = await this.request({ type: 'set_auto_compaction', enabled })
    if (!res.success) throw new Error(`pi set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getSessionStats(timeoutMs?: number): Promise<PiSessionStats> {
    const res = await this.request({ type: 'get_session_stats' }, { timeoutMs })
    if (!res.success) throw new Error(`pi get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`)
    return (res.data ?? {}) as PiSessionStats
  }

  async setSessionName(name: string): Promise<void> {
    const res = await this.request({ type: 'set_session_name', name })
    if (!res.success) throw new Error(`pi set_session_name failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    const res = await this.request({ type: 'export_html', outputPath })
    if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data: any = res.data
    return { path: String(data?.path ?? '') }
  }

  async switchSession(sessionPath: string): Promise<void> {
    const res = await this.request({ type: 'switch_session', sessionPath })
    if (!res.success) throw new Error(`pi switch_session failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getMessages(): Promise<unknown> {
    const res = await this.request({ type: 'get_messages' })
    if (!res.success) throw new Error(`pi get_messages failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getCommands(): Promise<unknown> {
    const res = await this.request({ type: 'get_commands' })
    if (!res.success) throw new Error(`pi get_commands failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    await this.writeLine(`${JSON.stringify({ type: 'extension_ui_response', ...response })}\n`)
  }

  private request(cmd: PiRpcCommand, opts?: { timeoutMs?: number }): Promise<PiRpcResponse> {
    if (this.terminalError) return Promise.reject(this.terminalError)
    const id = crypto.randomUUID()
    const withId = { ...cmd, id }
    const timeoutMs = opts?.timeoutMs

    const line = `${JSON.stringify(withId)}\n`

    return new Promise<PiRpcResponse>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined

      // Returns false when the id was already dropped (e.g. by the timeout), so the
      // caller can avoid settling the promise twice.
      const drop = (): boolean => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        return this.pending.delete(id)
      }

      this.pending.set(id, {
        resolve: res => {
          drop()
          resolve(res)
        },
        reject: error => {
          drop()
          reject(error)
        }
      })

      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timer = undefined
          if (!this.pending.delete(id)) return
          reject(Object.assign(new Error(`pi ${cmd.type} timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }))
        }, timeoutMs)
        // Never let an auxiliary request keep the event loop alive.
        timer.unref?.()
      }

      void this.writeLine(line).catch(error => {
        if (!drop()) return
        reject(error)
      })
    })
  }

  private writeLine(line: string): Promise<void> {
    if (this.terminalError) return Promise.reject(this.terminalError)
    return new Promise<void>((resolve, reject) => {
      try {
        this.child.stdin.write(line, error => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      } catch (error: unknown) {
        reject(error)
      }
    })
  }

  /**
   * Latch the first terminal failure, reject everything pending, and make every
   * later request fail fast instead of writing to a dead child. Event handlers
   * are notified once so upper layers can surface the failure to the client.
   */
  private fail(error: Error): void {
    const firstFailure = !this.terminalError
    this.terminalError ??= error
    this.startupEvents = null
    this.startupEventBytes = 0
    for (const [, pending] of this.pending) pending.reject(this.terminalError)
    this.pending.clear()
    if (firstFailure) {
      for (const handler of this.eventHandlers)
        handler({ type: 'pi_acp_process_error', message: this.terminalError.message })
    }
  }
}
