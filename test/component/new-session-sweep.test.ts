import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionManager, PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession(manager: SessionManager, id: string, proc: FakePiRpcProcess): PiAcpSession {
  return manager.getOrCreate(id, {
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(new FakeAgentSideConnection()),
    fileCommands: [],
    proc: proc as any
  })
}

test('SessionManager.closeIdleExcept keeps a session with an in-flight turn', async () => {
  const manager = new SessionManager()
  const procA = new FakePiRpcProcess()
  const procB = new FakePiRpcProcess()
  const sessionA = makeSession(manager, 'a', procA)
  makeSession(manager, 'b', procB)

  const turn = sessionA.prompt('streaming')
  assert.equal(procA.prompts.length, 1)

  // Creating session B must not tear down session A's subprocess mid-turn.
  manager.closeIdleExcept('b')
  assert.equal(procA.disposeCount, 0)
  assert.equal(sessionA.isTurnActive(), true)

  // The turn still completes normally once pi settles.
  procA.emit({ type: 'agent_start' })
  procA.emit({ type: 'turn_end' })
  procA.emit({ type: 'agent_end' })
  procA.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.equal(sessionA.isTurnActive(), false)

  // Once idle, the sweep reclaims the subprocess (leak prevention).
  manager.closeIdleExcept('b')
  assert.equal(procA.disposeCount, 1)
})

test('SessionManager.closeIdleExcept keeps a session with only queued prompts', async () => {
  const manager = new SessionManager()
  const procA = new FakePiRpcProcess()
  const sessionA = makeSession(manager, 'a', procA)
  makeSession(manager, 'b', new FakePiRpcProcess())

  // First prompt resolves immediately in the fake; without settle events the
  // turn stays pending, so the second prompt is queued behind it.
  const first = sessionA.prompt('first')
  const second = sessionA.prompt('second')
  assert.equal(procA.prompts.length, 1)

  manager.closeIdleExcept('b')
  assert.equal(procA.disposeCount, 0)

  await sessionA.cancel()
  assert.equal(await second, 'cancelled')
  procA.emit({ type: 'agent_start' })
  procA.emit({ type: 'turn_end' })
  procA.emit({ type: 'agent_end' })
  procA.emit({ type: 'agent_settled' })
  assert.equal(await first, 'cancelled')
})

test('SessionManager.closeIdleExcept closes idle sessions other than the keeper', () => {
  const manager = new SessionManager()
  const procA = new FakePiRpcProcess()
  const procB = new FakePiRpcProcess()
  makeSession(manager, 'a', procA)
  const sessionB = makeSession(manager, 'b', procB)

  manager.closeIdleExcept('b')
  assert.equal(procA.disposeCount, 1)
  assert.equal(procB.disposeCount, 0)
  assert.equal(manager.maybeGet('a'), undefined)
  assert.equal(manager.maybeGet('b'), sessionB)
})

test('closing an active session cancels its queue and ignores late events', async () => {
  const manager = new SessionManager()
  const proc = new FakePiRpcProcess()
  const session = makeSession(manager, 'a', proc)
  const first = session.prompt('first')
  const second = session.prompt('second')

  manager.close('a')
  session.dispose()
  assert.equal(await first, 'cancelled')
  assert.equal(await second, 'cancelled')
  assert.equal(proc.disposeCount, 1)
  assert.equal(session.isTurnActive(), false)

  proc.emit({ type: 'agent_settled' })
  assert.equal(await session.prompt('after close'), 'cancelled')
  assert.equal(proc.prompts.length, 1)
})
