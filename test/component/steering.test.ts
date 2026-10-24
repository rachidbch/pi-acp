import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { FakePiRpcProcess } from '../helpers/fakes.js'
import { PiAcpSession } from '../../src/acp/session.js'

test('steering advertises capability and rejects invalid requests', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  try {
    const init = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} })
    assert.deepEqual(init._meta?.steering, { supported: true })
    for (const request of [null, {}, { sessionId: 'missing', prompt: [] }, { sessionId: 'missing', prompt: [{ type: 'text', text: 'x' }], _meta: { steering: { idleBehavior: 'start' } } }]) {
      await assert.rejects(agent.steer(request), { code: -32602 })
    }
  } finally { agent.dispose() }
})

test('steering replays extension steers then follow-ups individually inside the open ACP turn', async () => {
  const proc = new FakePiRpcProcess()
  let queue = { steering: ['extension'], followUp: ['follow'] }
  Object.assign(proc, { clearQueue: async () => { const result = queue; queue = { steering: [], followUp: [] }; return result } })
  const session = new PiAcpSession({ sessionId: 's', cwd: process.cwd(), mcpServers: [], proc: proc as any, conn: asAgentConn(new FakeAgentSideConnection()) })
  try {
    const result = session.prompt('original')
    await new Promise(resolve => setImmediate(resolve))
    proc.emit({ type: 'agent_end' })
    proc.emit({ type: 'agent_settled' })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(proc.prompts.map(item => item.message), ['original', 'extension'])
    proc.emit({ type: 'agent_settled' })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(proc.prompts.map(item => item.message), ['original', 'extension', 'follow'])
    proc.emit({ type: 'agent_settled' })
    assert.equal(await result, 'end_turn')
    assert.deepEqual(await session.steer('idle'), { outcome: 'promptRequired' })
  } finally { session.dispose() }
})
