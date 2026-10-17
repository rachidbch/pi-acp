import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession, type TurnUsage } from '../../src/acp/session.js'
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

function settle(proc: FakePiRpcProcess): void {
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
}

test('prompt fills derived usage from context snapshots around the turn', { timeout: 5000 }, async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  let tokens = 100
  proc.getSessionStats = async () => ({ contextUsage: { tokens, contextWindow: 1000 } })
  const session = createSession(conn, proc)

  const usageOut: { usage?: TurnUsage } = {}
  const pending = session.prompt('hello', [], undefined, undefined, usageOut)
  // The turn-start snapshot has been taken once the prompt reached the fake process.
  for (let i = 0; i < 10 && proc.prompts.length === 0; i++) await Promise.resolve()
  tokens = 175
  settle(proc)
  assert.equal(await pending, 'end_turn')
  assert.deepEqual(usageOut.usage, { totalTokens: 175, inputTokens: 100, outputTokens: 75 })
})

test('prompt omits usage when the context shrank mid-turn (compaction)', { timeout: 5000 }, async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  let tokens = 400
  proc.getSessionStats = async () => ({ contextUsage: { tokens, contextWindow: 1000 } })
  const session = createSession(conn, proc)

  const usageOut: { usage?: TurnUsage } = {}
  const pending = session.prompt('hello', [], undefined, undefined, usageOut)
  for (let i = 0; i < 10 && proc.prompts.length === 0; i++) await Promise.resolve()
  tokens = 120
  settle(proc)
  assert.equal(await pending, 'end_turn')
  assert.equal(usageOut.usage, undefined)
})

test('prompt omits usage when stats are unavailable', { timeout: 5000 }, async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getSessionStats = async () => {
    throw new Error('stats unavailable')
  }
  const session = createSession(conn, proc)

  const usageOut: { usage?: TurnUsage } = {}
  const pending = session.prompt('hello', [], undefined, undefined, usageOut)
  settle(proc)
  assert.equal(await pending, 'end_turn')
  assert.equal(usageOut.usage, undefined)
})

test('cancelled turns never carry usage', { timeout: 5000 }, async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getSessionStats = async () => ({ contextUsage: { tokens: 50, contextWindow: 1000 } })
  const session = createSession(conn, proc)

  const usageOut: { usage?: TurnUsage } = {}
  const controller = new AbortController()
  const pending = session.prompt('hello', [], undefined, controller.signal, usageOut)
  controller.abort()
  settle(proc)
  assert.equal(await pending, 'cancelled')
  assert.equal(usageOut.usage, undefined)
})
