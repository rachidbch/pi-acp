import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

function fixture(models: unknown[]) {
  const conn = new FakeAgentSideConnection()
  const state = { thinkingLevel: 'off', model: { provider: 'test', id: 'plain' } }
  const proc = {
    onEvent: () => () => {},
    getMessages: async () => ({ messages: [] }),
    getState: async () => state,
    getAvailableModels: async () => ({ models }),
    getAvailableThinkingLevels: async () => ['off'],
    setThinkingLevel: async () => {},
    setModel: async () => {}
  }
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc,
    setStartupInfo() {},
    sendStartupInfoIfPending() {},
    async publishContextUsage() {}
  }
  const agent = new PiAcpAgent(asAgentConn(conn))
  Reflect.set(agent, 'sessions', {
    maybeGet: () => session,
    get: () => session,
    create: async () => session,
    close() {}
  })
  return { agent }
}

test('advertised model display names differ from model ids', async () => {
  const { agent } = fixture([
    { provider: 'test', id: 'sonnet', name: 'sonnet' },
    { provider: 'test', id: 'plain' },
    { provider: 'test', id: 'other', name: 'Fancy Name' }
  ])

  const res = await agent.newSession({ cwd: process.cwd(), mcpServers: [] })
  const payload = (res as { models?: { availableModels?: unknown } | null }).models
  const models = ((payload?.availableModels as Array<{ modelId: string; name: string }> | undefined) ?? []).filter(
    (m): m is { modelId: string; name: string } => Boolean(m?.modelId)
  )
  const byId = new Map(models.map(m => [m.modelId, m]))

  assert.equal(byId.size, 3)
  for (const model of models) {
    assert.notEqual(model.name, model.modelId, `display name for ${model.modelId} must differ from its id`)
  }
  assert.equal(byId.get('test/sonnet')?.name, 'test sonnet')
  assert.equal(byId.get('test/plain')?.name, 'test plain')
  assert.equal(byId.get('test/other')?.name, 'test/Fancy Name')
})
