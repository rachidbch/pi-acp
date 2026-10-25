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

test('toolcall_start surfaces a pending tool card from the pi 1.4 event id and toolName', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  createSession(conn, proc)

  // pi 1.4 puts `id` and `toolName` on the event itself; the partial message may not
  // carry the tool call object yet this early.
  proc.emit({
    type: 'message_update',
    message: { role: 'assistant', timestamp: 1 },
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'tc-start-1', toolName: 'read' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  const update = conn.updates[0]!.update as any
  assert.equal(update.sessionUpdate, 'tool_call')
  assert.equal(update.toolCallId, 'tc-start-1')
  assert.equal(update.title, 'read')
  assert.equal(update.name, 'read')
  assert.equal(update.status, 'pending')
})

test('tool_execution_start transitions the streamed start-card instead of duplicating it', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  createSession(conn, proc)

  proc.emit({
    type: 'message_update',
    message: { role: 'assistant', timestamp: 1 },
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'tc-start-2', toolName: 'read' }
  })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'tc-start-2', toolName: 'read', args: { path: 'src/acp/session.ts' } })

  await new Promise(r => setTimeout(r, 0))

  // Start and completion share one stable id: card at start, in_progress transition on execution.
  assert.deepEqual(
    conn.updates.map(u => ({
      sessionUpdate: (u.update as any).sessionUpdate,
      toolCallId: (u.update as any).toolCallId,
      status: (u.update as any).status
    })),
    [
      { sessionUpdate: 'tool_call', toolCallId: 'tc-start-2', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-start-2', status: 'in_progress' }
    ]
  )
})
