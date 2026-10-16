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
  return { session, conn, proc }
}

test('live chunks group by assistant message and match replay identifiers', async () => {
  const { session, conn, proc } = fixture()
  const messages = [
    { role: 'assistant', timestamp: 42, content: [] },
    { role: 'assistant', timestamp: 42, content: [] }
  ]
  const turn = session.prompt('work')
  for (const message of messages) {
    proc.emit({ type: 'message_start', message })
    proc.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'thinking_delta', delta: 'thought' } })
    proc.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', delta: 'hello' } })
    proc.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', delta: ' world' } })
    proc.emit({ type: 'message_end', message })
  }
  await Promise.resolve()
  proc.emit({ type: 'agent_settled' })
  await turn
  const ids = conn.updates.flatMap(({ update }) =>
    update.sessionUpdate === 'agent_message_chunk' ? [update.messageId] : []
  )
  assert.deepEqual(ids, [
    'pi-acp:assistant:42:1',
    'pi-acp:assistant:42:1',
    'pi-acp:assistant:42:2',
    'pi-acp:assistant:42:2'
  ])
  const replay = fixture()
  assert.deepEqual(
    messages.map(message => replay.session.messageIdForReplay(message)),
    [ids[0], ids[2]]
  )
  const thoughtIds = conn.updates.flatMap(({ update }) =>
    update.sessionUpdate === 'agent_thought_chunk' ? [update.messageId] : []
  )
  assert.deepEqual(thoughtIds, ['pi-acp:assistant:42:1:thought', 'pi-acp:assistant:42:2:thought'])
  session.dispose()
  replay.session.dispose()
})

test('resumed history seeds collision counters without replaying chunks', () => {
  const { session, conn } = fixture()
  session.seedMessageIds([
    { role: 'assistant', timestamp: 42 },
    { role: 'assistant', timestamp: 42 }
  ])
  assert.equal(session.messageIdForReplay({ role: 'assistant', timestamp: 42 }), 'pi-acp:assistant:42:3')
  assert.equal(conn.updates.length, 0)
  session.dispose()
})
