import type { AcpClient } from '../../src/acp/connection.js'
import type { PiPromptDisposition, PiRpcEvent, PiSessionStats } from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = Parameters<AcpClient['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly permissionRequests: unknown[] = []
  readonly extNotifications: Array<{ method: string; params: unknown }> = []
  private readonly abortController = new AbortController()
  get signal(): AbortSignal {
    return this.abortController.signal
  }
  nextPermissionResponse: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } = {
    outcome: { outcome: 'selected', optionId: 'allow' }
  }

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }

  extNotification(method: string, params?: unknown): Promise<void> {
    this.extNotifications.push({ method, params })
    return Promise.resolve()
  }

  async requestPermission(
    params: unknown
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    this.permissionRequests.push(params)
    return this.nextPermissionResponse
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0
  disposeCount = 0
  getSessionStatsCount = 0

  sessionStats: PiSessionStats = {}
  /** When set, `getSessionStats()` rejects with this error. */
  sessionStatsError: unknown = null

  dispose(): void {
    this.disposeCount++
  }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  promptDisposition: PiPromptDisposition | undefined

  async prompt(
    message: string,
    attachments: unknown[] = [],
    _timeoutMs?: number,
    onDisposition?: (disposition: PiPromptDisposition | undefined) => void
  ): Promise<PiPromptDisposition | undefined> {
    this.prompts.push({ message, attachments })
    onDisposition?.(this.promptDisposition)
    return this.promptDisposition
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  async sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  async getState(): Promise<any> {
    return {}
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    return ['medium', 'high']
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }

  async getSessionStats(): Promise<PiSessionStats> {
    this.getSessionStatsCount += 1
    if (this.sessionStatsError) throw this.sessionStatsError
    return this.sessionStats
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AcpClient {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AcpClient
}
