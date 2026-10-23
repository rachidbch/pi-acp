import test from 'node:test'
import assert from 'node:assert/strict'
import { client, ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { connectPiAgent } from '../../src/acp/connection.js'
import { SessionManager } from '../../src/acp/session.js'
import { FakePiRpcProcess } from '../helpers/fakes.js'

type Update = { sessionUpdate: string; [key: string]: unknown }

test(
  'updates emitted across a representative turn round-trip through the SDK client parser',
  { timeout: 5000 },
  async t => {
    const agentToClient = new TransformStream<Uint8Array>()
    const clientToAgent = new TransformStream<Uint8Array>()
    const server = connectPiAgent(ndJsonStream(agentToClient.writable, clientToAgent.readable))
    t.after(() => server.connection.close())

    const app = client()
    const updates: Update[] = []
    app.onNotification('session/update', ctx => {
      updates.push((ctx.params as { update: Update }).update)
    })
    const clientConn = app.connect(ndJsonStream(clientToAgent.writable, agentToClient.readable))
    t.after(() => clientConn.close())

    const proc = new FakePiRpcProcess()
    proc.sessionStats = { contextUsage: { tokens: 500, contextWindow: 1000 } }
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
      proc: proc as never,
      clientCapabilities: { session: { notices: {} } }
    })

    const responsePromise = clientConn.agent.request('session/prompt', {
      sessionId: 's1',
      prompt: [{ type: 'text', text: 'golden' }]
    })
    // Wait for the turn to actually reach the fake pi process before scripting events.
    for (let i = 0; i < 50 && proc.prompts.length === 0; i++) await Promise.resolve()
    assert.equal(proc.prompts.length, 1, 'prompt must reach the pi process')

    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello ' } })
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' } })
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'world' } })
    proc.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hello world' }] } })
    proc.emit({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'edit',
      args: { path: 'src/a.ts', oldText: 'a', newText: 'b' }
    })
    proc.emit({ type: 'tool_execution_update', toolCallId: 't1', partialResult: 'working' })
    proc.emit({ type: 'tool_execution_end', toolCallId: 't1', result: 'done' })
    proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1000 })
    proc.emit({ type: 'auto_retry_end' })
    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'turn_end' })
    proc.emit({ type: 'agent_end' })
    proc.emit({ type: 'agent_settled' })

    const response = (await responsePromise) as { stopReason: string; usage?: { totalTokens: number } }
    console.error('DEBUG updates:', JSON.stringify(updates.map(u => u.sessionUpdate)))
    assert.equal(response.stopReason, 'end_turn')
    assert.equal(response.usage?.totalTokens, 500)

    const kinds = new Set(updates.map(u => u.sessionUpdate))
    for (const expected of [
      'agent_message_chunk',
      'agent_thought_chunk',
      'tool_call',
      'tool_call_update',
      'session_info_update',
      'usage_update',
      'notice'
    ]) {
      assert.ok(kinds.has(expected), `expected update inventory to include ${expected}; got ${[...kinds].join(', ')}`)
    }
  }
)
