import test from 'node:test'
import assert from 'node:assert/strict'
import { ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { connectPiAgent } from '../../src/acp/connection.js'
import { PiAcpSession, SessionManager } from '../../src/acp/session.js'
import { FakePiRpcProcess } from '../helpers/fakes.js'

test('JSON-RPC request cancellation reaches pi and responds cancelled', { timeout: 5000 }, async t => {
  const input = new TransformStream<Uint8Array>()
  const output = new TransformStream<Uint8Array>()
  const server = connectPiAgent(ndJsonStream(output.writable, input.readable))
  const writer = input.writable.getWriter()
  const reader = output.readable.getReader()
  t.after(() => server.connection.close())
  const proc = new FakePiRpcProcess()
  let started!: () => void
  const promptStarted = new Promise<void>(resolve => {
    started = resolve
  })
  const prompt = proc.prompt.bind(proc)
  proc.prompt = async (...args) => {
    started()
    return prompt(...args)
  }
  const manager = Reflect.get(server.agent, 'sessions') as SessionManager
  manager.getOrCreate('s1', {
    cwd: process.cwd(),
    mcpServers: [],
    conn: {
      signal: server.connection.signal,
      sessionUpdate: params => server.connection.client.notify('session/update', params),
      requestPermission: params => server.connection.client.request('session/request_permission', params),
      createElicitation: params => server.connection.client.request('elicitation/create', params),
      extNotification: (method, params) => server.connection.client.notify(method, params)
    },
    proc: proc as never
  })
  t.after(() => server.agent.dispose())
  const received: Array<Record<string, unknown>> = []
  const completed = (async () => {
    let buffered = ''
    const decoder = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) throw new Error('connection closed before prompt response')
      buffered += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        const message = JSON.parse(line) as Record<string, unknown>
        received.push(message)
        if (message.id === 7) return message
      }
    }
  })()
  const send = (value: unknown) => writer.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`))
  await send({
    jsonrpc: '2.0',
    id: 7,
    method: 'session/prompt',
    params: { sessionId: 's1', prompt: [{ type: 'text', text: 'work' }] }
  })
  await promptStarted
  let aborted!: () => void
  const abortReceived = new Promise<void>(resolve => {
    aborted = resolve
  })
  const abort = proc.abort.bind(proc)
  proc.abort = async () => {
    await abort()
    aborted()
  }
  await send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 7 } })
  await abortReceived
  proc.emit({ type: 'agent_settled' })
  const response = await completed
  assert.deepEqual(response.result, { stopReason: 'cancelled' })
  assert.equal(proc.abortCount, 1)
  assert.equal(received.filter(message => message.id === 7).length, 1)
})

test('session cancellation sends $/cancel_request for a pending ACP dialog', { timeout: 5000 }, async t => {
  const input = new TransformStream<Uint8Array>()
  const output = new TransformStream<Uint8Array>()
  const server = connectPiAgent(ndJsonStream(output.writable, input.readable))
  const writer = input.writable.getWriter()
  const reader = output.readable.getReader()
  t.after(() => server.connection.close())
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 'dialog-session',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as never,
    conn: Reflect.get(server.agent, 'conn'),
    clientCapabilities: { elicitation: { form: {} } },
    fileCommands: []
  })
  t.after(() => session.dispose())

  let buffered = ''
  const decoder = new TextDecoder()
  const nextMessage = async () => {
    for (;;) {
      const newline = buffered.indexOf('\n')
      if (newline >= 0) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        return JSON.parse(line) as Record<string, any>
      }
      const { value, done } = await reader.read()
      if (done) throw new Error('connection closed before expected message')
      buffered += decoder.decode(value, { stream: true })
    }
  }
  const send = (value: unknown) => writer.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`))

  proc.emit({ type: 'extension_ui_request', id: 'ui-connection', method: 'input', title: 'Continue?' })
  const request = await nextMessage()
  assert.equal(request.method, 'elicitation/create')

  await session.cancel()
  const cancellation = await nextMessage()
  assert.equal(cancellation.method, '$/cancel_request')
  assert.deepEqual(cancellation.params, { requestId: request.id })
  await send({ jsonrpc: '2.0', id: request.id, error: { code: -32800, message: 'Request cancelled' } })
})
