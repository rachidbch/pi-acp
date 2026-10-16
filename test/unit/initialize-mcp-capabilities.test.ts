import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('initialize advertises the http MCP capability pi natively supports', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const res = await agent.initialize({ protocolVersion: 1 } as any)

  assert.equal(res.agentCapabilities?.mcpCapabilities?.http, true)
  assert.equal(res.agentCapabilities?.mcpCapabilities?.sse, false)
})
