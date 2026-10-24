import type {
  ClientCapabilities,
  ElicitationPropertySchema,
  PermissionOption,
  SessionUpdate
} from '@agentclientprotocol/sdk/unstable'
import { CreateElicitationResponse } from '@agentclientprotocol/sdk/unstable'
import type { AcpClient } from './connection.js'

export type ExtensionUiResponse = { id: string } & ({ value: string } | { confirmed: boolean } | { cancelled: true })

export interface ExtensionUiHost {
  sessionId: string
  conn: AcpClient
  clientCapabilities?: ClientCapabilities
  trustedParent?: boolean
  sendResponse(response: ExtensionUiResponse): Promise<void>
  emit(update: SessionUpdate): void | Promise<void>
  signal?: AbortSignal
}

const CONFIRM_OPTIONS: PermissionOption[] = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'no', name: 'No', kind: 'reject_once' }
]
const SECRET_DISCLOSURE = 'Do not enter passwords, tokens, or other secrets.'
const CREDENTIAL_TEXT =
  /\b(?:passwords?|passphrases?|secrets?|credentials?|api[\s_-]*keys?|(?:(?:api|access|refresh|auth(?:entication)?|bearer|session)[\s_-]*)?tokens?|(?:private|ssh)[\s_-]*keys?)\b/i
const SECRET_FLAGS = ['sensitive', 'password', 'secret', 'isSensitive', 'isPassword', 'isSecret']

type DialogResult<T> = { state: 'answered'; value: T } | { state: 'cancelled' | 'expired' }

/** Handles Pi RPC UI only; ongoing status/widget snapshots belong to the session. */
export async function handleExtensionUiRequest(event: Record<string, unknown>, host: ExtensionUiHost): Promise<void> {
  const method = text(event, 'method')
  if (method === 'notify') {
    const level = text(event, 'notifyType')
    try {
      const message = text(event, 'message') || 'Pi notification'
      const severity = level === 'warning' || level === 'error' ? level : 'info'
      await host.emit(
        host.clientCapabilities?.session?.notices != null
          ? {
              sessionUpdate: 'notice',
              severity,
              title: message
            }
          : {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: message },
              _meta: { piAcp: { notify: { level: severity } } }
            }
      )
    } catch {
      // Notifications never require a response, including on delivery failure.
    }
    return
  }
  if (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor') return

  const id = text(event, 'id')
  if (!id) return
  let replied = false
  const reply = async (response: ExtensionUiResponse) => {
    if (replied) return
    replied = true
    try {
      await host.sendResponse(host.signal?.aborted || host.conn.signal.aborted ? { id, cancelled: true } : response)
    } catch {
      // A failed write must not be retried as a second response.
    }
  }
  const cancel = () => reply({ id, cancelled: true })

  try {
    if (method === 'confirm') {
      const result = await waitForDialog(event, host, signal =>
        host.conn.requestPermission(
          {
            sessionId: host.sessionId,
            toolCall: permissionToolCall(id, method, event),
            options: CONFIRM_OPTIONS
          },
          signal
        )
      )
      if (result.state === 'expired') return
      if (result.state !== 'answered' || result.value.outcome.outcome !== 'selected') return await cancel()
      const optionId = result.value.outcome.optionId
      if (optionId !== 'yes' && optionId !== 'no') return await cancel()
      return await reply({ id, confirmed: optionId === 'yes' })
    }

    const title = text(event, 'title') ?? `Pi ${method}`
    let options: string[] | undefined
    if (method === 'select') {
      const raw = event.options
      if (!Array.isArray(raw) || raw.length === 0 || !raw.every(option => typeof option === 'string')) {
        return await cancel()
      }
      options = raw
      if (!host.clientCapabilities?.elicitation?.form) {
        const result = await waitForDialog(event, host, signal =>
          host.conn.requestPermission(
            {
              sessionId: host.sessionId,
              toolCall: permissionToolCall(id, method, event),
              // Compatibility buttons only: option labels do not define authorization policy.
              options: raw.map((name, index) => ({ optionId: `choice-${index}`, name, kind: 'allow_once' }))
            },
            signal
          )
        )
        if (result.state === 'expired') return
        if (result.state !== 'answered' || result.value.outcome.outcome !== 'selected') return await cancel()
        const index = choiceIndex(result.value.outcome.optionId)
        const value = index === null ? undefined : options[index]
        return await reply(value === undefined ? { id, cancelled: true } : { id, value })
      }
    } else {
      if (!isPlainTextRequest(event, host.trustedParent === true)) {
        await unsupported(host, method, 'Sensitive or custom-schema text requests are not supported.')
        return await cancel()
      }
      if (!host.clientCapabilities?.elicitation?.form) {
        await unsupported(host, method, 'This client does not support text forms.')
        return await cancel()
      }
    }

    const field: ElicitationPropertySchema = {
      type: 'string',
      title,
      ...(options ? { enum: [...new Set(options)] } : {}),
      ...(method === 'input' && typeof event.placeholder === 'string' ? { description: event.placeholder } : {}),
      ...(method === 'editor' && typeof event.prefill === 'string' ? { default: event.prefill } : {})
    }
    const result = await waitForDialog(event, host, signal =>
      host.conn.createElicitation(
        {
          sessionId: host.sessionId,
          mode: 'form',
          message: options ? title : `${title}\n\n${SECRET_DISCLOSURE}`,
          requestedSchema: { type: 'object', properties: { value: field }, required: ['value'] }
        },
        signal
      )
    )
    if (result.state === 'expired') return
    if (result.state !== 'answered' || !CreateElicitationResponse.isAccept(result.value)) return await cancel()
    const value = result.value.content?.value
    if (typeof value !== 'string' || (options && !options.includes(value))) return await cancel()
    await reply({ id, value })
  } catch {
    await cancel()
  }
}

function text(event: Record<string, unknown>, key: string): string | undefined {
  return typeof event[key] === 'string' ? event[key] : undefined
}

function permissionToolCall(id: string, method: string, event: Record<string, unknown>) {
  const rawInput: Record<string, unknown> = { method }
  for (const key of ['title', 'message', 'options']) {
    if (Object.hasOwn(event, key)) rawInput[key] = event[key]
  }
  const message = text(event, 'message')
  return {
    toolCallId: `pi-ui-${id}`,
    title: text(event, 'title') ?? `Pi ${method}`,
    kind: 'other' as const,
    status: 'pending' as const,
    rawInput,
    ...(message ? { content: [{ type: 'content' as const, content: { type: 'text' as const, text: message } }] } : {})
  }
}

function choiceIndex(optionId: string): number | null {
  const match = /^choice-(0|[1-9]\d*)$/.exec(optionId)
  if (!match) return null
  const index = Number(match[1])
  return Number.isSafeInteger(index) ? index : null
}

function isPlainTextRequest(event: Record<string, unknown>, trustedParent: boolean): boolean {
  if (SECRET_FLAGS.some(key => event[key] !== undefined && event[key] !== null && event[key] !== false)) return false
  if (event.inputType !== undefined && event.inputType !== 'text' && event.inputType !== 'textarea') return false
  if (event.type !== undefined && event.type !== 'extension_ui_request') return false
  if (['schema', 'requestedSchema', 'properties', 'format'].some(key => Object.hasOwn(event, key))) return false
  for (const key of ['title', 'message', 'placeholder', 'prefill']) {
    if (event[key] !== undefined && typeof event[key] !== 'string') return false
  }
  // Deny-only guard, not proof of non-sensitive intent: Pi has no sensitivity contract.
  return trustedParent || !['title', 'message', 'placeholder'].some(key => CREDENTIAL_TEXT.test(text(event, key) ?? ''))
}

async function unsupported(host: ExtensionUiHost, method: string, reason: string): Promise<void> {
  await host.emit({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: `Pi ${method} UI request cancelled. ${reason}` }
  })
}

function waitForDialog<T>(
  event: Record<string, unknown>,
  host: ExtensionUiHost,
  request: (signal: AbortSignal) => Promise<T>
): Promise<DialogResult<T>> {
  const signals = [...new Set([host.signal, host.conn.signal].filter((signal): signal is AbortSignal => !!signal))]
  if (signals.some(signal => signal.aborted)) return Promise.resolve({ state: 'cancelled' })
  const timeout = event.timeout
  const timeoutMs = typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? timeout : undefined
  const deadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs

  return new Promise(resolve => {
    const requestController = new AbortController()
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: DialogResult<T>) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (result.state !== 'answered') requestController.abort()
      for (const signal of signals) signal.removeEventListener('abort', aborted)
      resolve(result)
    }
    const aborted = () => finish({ state: 'cancelled' })
    const expire = () => {
      const remaining = (deadline ?? 0) - performance.now()
      if (remaining <= 0) finish({ state: 'expired' })
      else timer = setTimeout(expire, Math.min(remaining, 2_147_483_647))
    }
    for (const signal of signals) signal.addEventListener('abort', aborted, { once: true })
    // Pi resolves its dialog on timeout; only release our wait and discard late answers.
    if (timeoutMs !== undefined) timer = setTimeout(expire, Math.min(timeoutMs, 2_147_483_647))
    try {
      request(requestController.signal).then(
        value => {
          if (deadline !== undefined && performance.now() >= deadline) finish({ state: 'expired' })
          else if (signals.some(signal => signal.aborted)) finish({ state: 'cancelled' })
          else finish({ state: 'answered', value })
        },
        () => finish({ state: 'cancelled' })
      )
    } catch {
      finish({ state: 'cancelled' })
    }
  })
}
