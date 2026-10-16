import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('initialize advertises an auth identity and pushes _auth/status_update', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const res = await agent.initialize({ protocolVersion: 1 } as any)

  const marker = (res as { agentCapabilities?: { _meta?: { authStatus?: { kind?: string; label?: string } } } })
    .agentCapabilities?._meta?.authStatus
  assert.equal(marker?.kind, 'api_key')
  assert.equal(marker?.label, 'pi')

  await new Promise(r => setTimeout(r, 5))
  const push = conn.extNotifications.find(n => n.method === '_auth/status_update')
  assert.ok(push, 'expected an _auth/status_update notification after initialize')
  const pushed = (push.params as { authStatus?: { kind?: string; label?: string } }).authStatus
  assert.equal(pushed?.kind, 'api_key')
  assert.equal(pushed?.label, 'pi')
})

test('unstable_listProviders returns an empty catalog', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const res = await agent.unstable_listProviders({} as never)
  assert.deepEqual(res, { providers: [] })
})
