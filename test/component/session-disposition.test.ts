import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession(proc: FakePiRpcProcess) {
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  return { session }
}

test('a handled prompt completes the turn without an agent loop', async () => {
  const proc = new FakePiRpcProcess()
  proc.promptDisposition = 'handled'
  const { session } = makeSession(proc)

  assert.equal(await session.prompt('hi'), 'end_turn')
})

test('a started prompt completes on agent_settled', async () => {
  const proc = new FakePiRpcProcess()
  proc.promptDisposition = 'started'
  const { session } = makeSession(proc)

  const turn = session.prompt('hi')
  await new Promise(r => setTimeout(r, 0))
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
})

test('prompts arriving during an unsettled turn queue instead of racing', async () => {
  const proc = new FakePiRpcProcess()
  proc.promptDisposition = 'started'
  const { session } = makeSession(proc)

  const first = session.prompt('one')
  await new Promise(r => setTimeout(r, 0))
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })

  const second = session.prompt('two')
  await new Promise(r => setTimeout(r, 0))
  assert.equal(proc.prompts.length, 1, 'queued prompt must not start before agent_settled')

  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'end_turn')
  await new Promise(r => setTimeout(r, 0))
  assert.equal(proc.prompts.length, 2, 'queued prompt starts after the running turn settles')

  proc.emit({ type: 'agent_settled' })
  assert.equal(await second, 'end_turn')
})
