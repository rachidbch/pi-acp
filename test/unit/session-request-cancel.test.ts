import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function fixture() {
  const proc = new FakePiRpcProcess()
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as never,
    conn: asAgentConn(conn)
  })
  return { session, proc, conn }
}

function settle(proc: FakePiRpcProcess) {
  proc.emit({ type: 'agent_settled' })
}

test('cancelling a queued request does not abort the active prompt', async () => {
  const { session, proc } = fixture()
  const first = session.prompt('first')
  const controller = new AbortController()
  const second = session.prompt('second', [], undefined, controller.signal)
  controller.abort()
  assert.equal(await second, 'cancelled')
  assert.equal(proc.abortCount, 0)
  assert.equal(proc.prompts.length, 1)
  await Promise.resolve()
  settle(proc)
  assert.equal(await first, 'end_turn')
  session.dispose()
})

test('an aborted request does not start pi', async () => {
  const { session, proc } = fixture()
  assert.equal(await session.prompt('ignored', [], undefined, AbortSignal.abort()), 'cancelled')
  assert.equal(proc.prompts.length, 0)
  session.dispose()
})

test('active request cancellation finishes tools once and ignores late tool events', async () => {
  const { session, proc, conn } = fixture()
  const controller = new AbortController()
  const prompt = session.prompt('work', [], undefined, controller.signal)
  proc.emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: {} })
  controller.abort()
  // The abort follows the received-event drain (a few microtasks on this sync-event path).
  for (let i = 0; i < 50 && proc.abortCount === 0; i++) await Promise.resolve()
  assert.equal(proc.abortCount, 1)
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'tool-1',
    toolName: 'read',
    result: { content: [{ type: 'text', text: 'late' }] }
  })
  settle(proc)
  assert.equal(await prompt, 'cancelled')
  const updates = conn.updates.filter(
    u => u.update.sessionUpdate === 'tool_call_update' && u.update.toolCallId === 'tool-1'
  )
  assert.equal(
    updates.filter(u => u.update.sessionUpdate === 'tool_call_update' && u.update.status === 'failed').length,
    1
  )
  assert.equal(
    updates.filter(u => u.update.sessionUpdate === 'tool_call_update' && u.update.status === 'completed').length,
    0
  )
  session.dispose()
})
