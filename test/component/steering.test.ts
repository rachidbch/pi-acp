import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

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
