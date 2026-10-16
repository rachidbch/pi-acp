import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

type Update = { sessionUpdate?: string; _meta?: { piAcp?: { keepalive?: boolean } } }

function keepalives(conn: FakeAgentSideConnection): Update[] {
  return conn.updates
    .map(u => (u as unknown as { update?: Update }).update)
    .filter((u): u is Update => u?.sessionUpdate === 'session_info_update' && u._meta?.piAcp?.keepalive === true)
}

function makeSession(): { session: PiAcpSession; conn: FakeAgentSideConnection; proc: FakePiRpcProcess } {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  return { session, conn, proc }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('quiet in-flight turns emit periodic session_info_update keepalives', async t => {
  t.after(() => {
    delete process.env.PI_ACP_KEEPALIVE_MS
  })
  process.env.PI_ACP_KEEPALIVE_MS = '120'
  const { session, conn, proc } = makeSession()

  const turn = session.prompt('slow work')
  await sleep(700)

  // The turn produced no pi events, so the only traffic after the turn-start
  // update should be keepalives.
  const firstWave = keepalives(conn).length
  assert.ok(firstWave >= 1, `expected at least one keepalive, got ${JSON.stringify(conn.updates)}`)

  // Fresh streaming output postpones the next keepalive.
  const before = keepalives(conn).length
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'progress ' } })
  await sleep(200)
  assert.equal(keepalives(conn).length, before)

  // Settling the turn stops the keepalive timer.
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  const settled = keepalives(conn).length
  await sleep(500)
  assert.equal(keepalives(conn).length, settled)
})

test('PI_ACP_KEEPALIVE_MS=0 disables the keepalive', async t => {
  t.after(() => {
    delete process.env.PI_ACP_KEEPALIVE_MS
  })
  process.env.PI_ACP_KEEPALIVE_MS = '0'
  const { session, conn, proc } = makeSession()

  const turn = session.prompt('silent')
  await sleep(400)
  assert.equal(keepalives(conn).length, 0)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await turn
})

test('dispose stops the keepalive timer', async t => {
  t.after(() => {
    delete process.env.PI_ACP_KEEPALIVE_MS
  })
  process.env.PI_ACP_KEEPALIVE_MS = '120'
  const { session, conn } = makeSession()

  const turn = session.prompt('slow work')
  session.dispose('cancelled')
  assert.equal(await turn, 'cancelled')

  await sleep(500)
  assert.equal(keepalives(conn).length, 0)
})
