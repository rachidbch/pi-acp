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
    for (const request of [
      null,
      {},
      { sessionId: 'missing', prompt: [] },
      { sessionId: 'missing', prompt: [{ type: 'text', text: 'x' }], _meta: { steering: { idleBehavior: 'start' } } }
    ]) {
      await assert.rejects(agent.steer(request), { code: -32602 })
    }
  } finally {
    agent.dispose()
  }
})

test('steering replays extension steers then follow-ups individually inside the open ACP turn', async () => {
  const proc = new FakePiRpcProcess()
  let queue = { steering: ['extension'], followUp: ['follow'] }
  Object.assign(proc, {
    clearQueue: async () => {
      const result = queue
      queue = { steering: [], followUp: [] }
      return result
    }
  })
  const session = new PiAcpSession({
    sessionId: 's',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(new FakeAgentSideConnection())
  })
  try {
    const result = session.prompt('original')
    await new Promise(resolve => setImmediate(resolve))
    proc.emit({ type: 'agent_end' })
    proc.emit({ type: 'agent_settled' })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(
      proc.prompts.map(item => item.message),
      ['original', 'extension']
    )
    proc.emit({ type: 'agent_settled' })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(
      proc.prompts.map(item => item.message),
      ['original', 'extension', 'follow']
    )
    proc.emit({ type: 'agent_settled' })
    assert.equal(await result, 'end_turn')
    assert.deepEqual(await session.steer('idle'), { outcome: 'promptRequired' })
  } finally {
    session.dispose()
  }
})

test('steering accepted while final usage publishes is replayed before ACP resolves', async () => {
  const proc = new FakePiRpcProcess()
  Object.assign(proc, { clearQueue: async () => ({ steering: [], followUp: [] }) })
  const session = new PiAcpSession({
    sessionId: 's',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(new FakeAgentSideConnection())
  })
  let release!: () => void
  session.publishContextUsage = () =>
    new Promise(resolve => {
      release = () => resolve(null)
    })
  try {
    const result = session.prompt('original')
    await new Promise(resolve => setImmediate(resolve))
    proc.emit({ type: 'agent_end' })
    proc.emit({ type: 'agent_settled' })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(await session.steer('late'), { outcome: 'injected' })
    release()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(
      proc.prompts.map(item => item.message),
      ['original', 'late']
    )
    session.publishContextUsage = async () => null
    proc.emit({ type: 'agent_settled' })
    assert.equal(await result, 'end_turn')
  } finally {
    session.dispose()
  }
})

test('steering cancel waits for in-flight injection before clearing pi queue and aborting', async () => {
  const proc = new FakePiRpcProcess()
  const order: string[] = []
  let release!: () => void
  Object.assign(proc, {
    steer: () =>
      new Promise(resolve => {
        release = () => {
          order.push('steer')
          resolve('queued')
        }
      }),
    clearQueue: async () => {
      order.push('clear')
      return { steering: [], followUp: [] }
    },
    abort: async () => {
      order.push('abort')
    }
  })
  const session = new PiAcpSession({
    sessionId: 's',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(new FakeAgentSideConnection())
  })
  try {
    const result = session.prompt('original')
    proc.emit({ type: 'agent_start' })
    const inject = session.steer('pending')
    const cancel = session.cancel()
    release()
    await Promise.all([inject, cancel])
    assert.deepEqual(order, ['steer', 'clear', 'abort'])
    proc.emit({ type: 'agent_settled' })
    assert.equal(await result, 'cancelled')
  } finally {
    session.dispose()
  }
})

test('steering held RPC failure ends its turn and does not poison a later prompt', async () => {
  const proc = new FakePiRpcProcess()
  Object.assign(proc, {
    steer: async () => {
      throw new Error('STEER_REJECTED')
    },
    clearQueue: async () => ({ steering: [], followUp: [] })
  })
  const session = new PiAcpSession({
    sessionId: 's',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(new FakeAgentSideConnection())
  })
  try {
    const result = assert.rejects(session.prompt('first'), /STEER_REJECTED/)
    await session.steer('held')
    proc.emit({ type: 'agent_start' })
    await new Promise(resolve => setImmediate(resolve))
    proc.emit({ type: 'agent_settled' })
    await result
    const next = session.prompt('second')
    await new Promise(resolve => setImmediate(resolve))
    proc.emit({ type: 'agent_settled' })
    assert.equal(await next, 'end_turn')
  } finally {
    session.dispose()
  }
})
