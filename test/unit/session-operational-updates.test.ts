import test from 'node:test'
import assert from 'node:assert/strict'
import type { ClientCapabilities } from '@agentclientprotocol/sdk/unstable'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function fixture(capabilities: ClientCapabilities = {}) {
  const proc = new FakePiRpcProcess()
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as never,
    conn: asAgentConn(conn),
    clientCapabilities: capabilities
  })
  return { session, conn, proc }
}

for (const prefix of ['compaction', 'auto_compaction']) {
  test(`${prefix} events publish correlated compaction status and actual summary`, async () => {
    const { session, proc, conn } = fixture({ session: { compaction: {} } })
    proc.emit({ type: `${prefix}_start`, reason: 'threshold' })
    proc.emit({ type: `${prefix}_end`, reason: 'threshold', aborted: false, result: { summary: 'actual summary' } })
    await session.publishContextUsage()
    const updates = conn.updates.map(u => u.update).filter(u => u.sessionUpdate === 'compaction_update')
    assert.equal(updates.length, 2)
    assert.deepEqual(
      updates.map(u => u.status),
      ['in_progress', 'completed']
    )
    assert.equal(updates[0]?.compactionId, updates[1]?.compactionId)
    assert.deepEqual(updates[1]?.summary, [{ type: 'text', text: 'actual summary' }])
    assert.equal(
      conn.updates.some(u => u.update.sessionUpdate === 'agent_message_chunk'),
      false
    )
    session.dispose()
  })
}

for (const [end, status] of [
  [{ aborted: true }, 'cancelled'],
  [{ errorMessage: 'actual failure' }, 'failed']
] as const) {
  test(`compaction ${status} has no invented summary`, async () => {
    const { session, proc, conn } = fixture({ session: { compaction: {} } })
    proc.emit({ type: 'compaction_start' })
    proc.emit({ type: 'compaction_end', ...end })
    await session.publishContextUsage()
    const updates = conn.updates.map(u => u.update).filter(u => u.sessionUpdate === 'compaction_update')
    assert.equal(updates[1]?.status, status)
    assert.equal(updates[1]?.summary, undefined)
    session.dispose()
  })
}

test('legacy clients receive text fallback instead of unnegotiated compaction updates', async () => {
  const { session, proc, conn } = fixture({ session: { compaction: null } })
  proc.emit({ type: 'compaction_start' })
  proc.emit({ type: 'compaction_end', aborted: true })
  await session.publishContextUsage()
  assert.equal(
    conn.updates.some(u => u.update.sessionUpdate === 'compaction_update'),
    false
  )
  const texts = conn.updates.flatMap(u =>
    u.update.sessionUpdate === 'agent_message_chunk' && u.update.content.type === 'text' ? [u.update.content.text] : []
  )
  assert.ok(texts.includes('Compaction cancelled.'))
  session.dispose()
})

test('negotiated notices report extension notifications without assistant text', async () => {
  const { session, proc, conn } = fixture({ session: { notices: {} } })
  proc.emit({ type: 'extension_ui_request', method: 'notify', notifyType: 'warning', message: 'actual warning' })
  await session.publishContextUsage()
  const notices = conn.updates.map(u => u.update).filter(u => u.sessionUpdate === 'notice')
  assert.deepEqual(notices, [{ sessionUpdate: 'notice', title: 'actual warning', severity: 'warning' }])
  assert.equal(
    conn.updates.some(u => u.update.sessionUpdate === 'agent_message_chunk'),
    false
  )
  session.dispose()
})

test('manual compaction does not duplicate native lifecycle events', async () => {
  const { session, proc, conn } = fixture({ session: { compaction: {} } })
  Object.assign(proc, {
    compact: async () => {
      proc.emit({ type: 'compaction_start', reason: 'manual' })
      proc.emit({ type: 'compaction_end', reason: 'manual', result: { summary: 'manual summary' } })
      return { summary: 'manual summary' }
    }
  })
  await session.compact()
  const updates = conn.updates.map(u => u.update).filter(u => u.sessionUpdate === 'compaction_update')
  assert.deepEqual(
    updates.map(u => u.status),
    ['in_progress', 'completed']
  )
  session.dispose()
})
