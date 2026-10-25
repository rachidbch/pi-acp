import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function createSession(conn: FakeAgentSideConnection, proc: FakePiRpcProcess): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as never,
    conn: asAgentConn(conn)
  })
}

function usageUpdates(conn: FakeAgentSideConnection): unknown[] {
  return conn.updates.filter(u => u.update.sessionUpdate === 'usage_update').map(u => u.update)
}

test('turn completion emits usage_update carrying the per-turn cost and token breakdown', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = { contextUsage: { tokens: 12_345, contextWindow: 200_000 } }
  const session = createSession(conn, proc)

  const pending = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'stop',
      usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, cost: { input: 0.2, output: 0.3, total: 0.5 } }
    }
  })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await pending, 'end_turn')

  // Per-turn cost first (so a parent can accumulate spend per turn), then the context snapshot.
  assert.deepEqual(usageUpdates(conn), [
    {
      sessionUpdate: 'usage_update',
      cost: { amount: 0.5, currency: 'USD' },
      _meta: { usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 20, cachedWriteTokens: 10 } }
    },
    { sessionUpdate: 'usage_update', used: 12_345, size: 200_000 }
  ])
})

test('every assistant message of the turn sums into the reported cost and breakdown', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = createSession(conn, proc)

  const pending = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.25 } }
  })
  proc.emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'stop',
      usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, cost: { total: 0.5 } }
    }
  })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await pending, 'end_turn')
  assert.deepEqual(usageUpdates(conn), [
    {
      sessionUpdate: 'usage_update',
      cost: { amount: 0.75, currency: 'USD' },
      _meta: { usage: { inputTokens: 110, outputTokens: 55, cachedReadTokens: 20, cachedWriteTokens: 10 } }
    }
  ])
})

test('cancelled turns still report the spend that already happened', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = createSession(conn, proc)

  const pending = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'aborted',
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } }
    }
  })
  await session.cancel()
  proc.emit({ type: 'agent_settled' })

  assert.equal(await pending, 'cancelled')
  assert.deepEqual(usageUpdates(conn), [
    {
      sessionUpdate: 'usage_update',
      cost: { amount: 0.5, currency: 'USD' },
      _meta: { usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedWriteTokens: 0 } }
    }
  ])
})

test('turns without reported usage emit no cost update', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = { contextUsage: { tokens: 12_345, contextWindow: 200_000 } }
  const session = createSession(conn, proc)

  const pending = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await pending, 'end_turn')
  assert.deepEqual(usageUpdates(conn), [{ sessionUpdate: 'usage_update', used: 12_345, size: 200_000 }])
})
